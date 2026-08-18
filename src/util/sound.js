// Sound, on a page that never had any.
//
// One AudioContext, a handful of decoded buffers, and a voice per shot. There is
// no mixer, no bus structure and no positional audio: everything that makes a
// noise here is a rifle held at the listener's shoulder, so the listener *is*
// the source and a PannerNode would be doing arithmetic to arrive at 1.
//
// Two things it does have to get right, and both are about a weapon on
// automatic rather than about audio in general.
//
// The first is the tail. The 5.56 sample is two and a third seconds long and
// almost all of that is the report coming back off whatever the shooter is
// standing in — which is the half of a gunshot that tells you where you are, and
// the half a short "gunshot.wav" throws away. Keeping it means that at ten rounds
// a second there are twenty overlapping copies of it, so the voices are capped
// and the oldest is faded out rather than cut: a hard stop on a decaying tail is
// a click, and a click is the one artefact the ear will not forgive.
//
// The second is that a browser will not start an AudioContext until the user has
// done something. `unlock()` is called from the same click that takes the pointer,
// which is a real gesture and always happens before the first shot.

const VOICE_STEAL = 0.05; // s to fade a stolen voice out over

export function createSoundBank(files, { master = 0.8, voices = 5 } = {}) {
  let ctx = null;
  let out = null;
  const buffers = new Map(); // name -> AudioBuffer
  const live = new Map(); // name -> [{ src, gain, at }], oldest first
  let loading = null;
  let failed = false;

  function start() {
    if (ctx || failed) return ctx;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) { failed = true; return null; }
    ctx = new AC();
    // A rifle is loud and the tails stack. Without this, four overlapping
    // reports clip the output and the whole thing turns to fuzz — which sounds
    // like a bad recording rather than like a lot of noise at once.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    out = ctx.createGain();
    out.gain.value = master;
    out.connect(comp).connect(ctx.destination);
    return ctx;
  }

  // Fetch and decode everything, once. Safe to call before any gesture: fetching
  // and decoding do not need a running context, only a constructed one.
  function load() {
    if (loading) return loading;
    if (!start()) return Promise.resolve(false);
    loading = Promise.all(Object.entries(files).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (e) {
        console.warn(`sound: ${name} (${url}) — ${e.message}`);
      }
    })).then(() => buffers.size > 0);
    return loading;
  }

  // The gesture. Chrome starts the context suspended and only a user action may
  // resume it; calling this from anywhere else is a no-op that costs a promise.
  function unlock() {
    if (!start()) return;
    load();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function retire(name, v, fade = VOICE_STEAL) {
    const list = live.get(name);
    if (list) {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
    }
    if (!v.stopping) {
      v.stopping = true;
      const t = ctx.currentTime;
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(0, t + fade);
        v.src.stop(t + fade + 0.01);
      } catch { /* already stopped */ }
    }
  }

  // `rate` is a playback-rate multiplier — the cheapest way to keep a repeated
  // sample from reading as a loop is to vary its pitch a per cent either side.
  function play(name, { gain = 1, rate = 1, vary = 0, delay = 0 } = {}) {
    if (!ctx || ctx.state !== 'running') return null;
    const buf = buffers.get(name);
    if (!buf) return null;

    const list = live.get(name) ?? [];
    if (!live.has(name)) live.set(name, list);
    while (list.length >= voices) retire(name, list[0]);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 2 * vary);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    const v = { src, gain: g, stopping: false };
    src.onended = () => retire(name, v, 0);
    src.start(ctx.currentTime + delay);
    list.push(v);
    return v;
  }

  // A bed of sound that has to be there continuously — the sea, and an engine
  // room when there is one — built out of a handful of short clips.
  //
  // Deliberately not a looping BufferSource. A twelve-second clip on
  // `loop = true` is recognisable as a loop inside a minute, and MP3's encoder
  // padding leaves a gap at the seam besides. Instead each clip is played whole
  // and once, from a random point in itself and at a slightly different rate
  // each time, fading up while the one before it fades down and choosing the
  // next at random from the set. Two chains of that, and there is no interval at
  // which the whole thing comes round again.
  //
  // The crossfade is equal-*power*, not equal-amplitude, which for two
  // uncorrelated recordings is the difference between a seamless handover and a
  // 3 dB hole in the middle of every one: uncorrelated signals add as a² + b²,
  // and a linear ramp puts that at 0.5 when both are half way.
  //
  // `step()` wants calling once a frame. It is not a timer — it compares the
  // audio clock against when the next clip is due, so the bed cannot drift out
  // of step with itself if the frame rate does.
  const RAMP_N = 32;
  const RAMP_UP = new Float32Array(RAMP_N + 1);
  const RAMP_DOWN = new Float32Array(RAMP_N + 1);
  for (let i = 0; i <= RAMP_N; i++) {
    RAMP_UP[i] = Math.sin((i / RAMP_N) * Math.PI * 0.5);
    RAMP_DOWN[i] = Math.cos((i / RAMP_N) * Math.PI * 0.5);
  }

  function ambience(names, { gain = 1, fade = 3, chains = 2, detune = 0.06 } = {}) {
    const nul = { level() {}, step() {}, stop() {} };
    if (!start()) return nul;

    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(out);

    const lanes = Array.from({ length: chains }, () => ({ due: 0, last: -1 }));
    let want = 0;
    let told = -1;
    let stopped = false;

    // Returns when the *next* clip on this chain should come in, which is one
    // crossfade before this one runs out.
    function launch(lane, at) {
      // Not the same clip twice running on one chain — with three of them that
      // is the one repeat the ear would catch.
      let k = Math.floor(Math.random() * names.length);
      if (names.length > 1 && k === lane.last) k = (k + 1) % names.length;
      const buf = buffers.get(names[k]);
      if (!buf) return at + 1; // not decoded yet; try again shortly
      lane.last = k;

      const rate = 1 + (Math.random() - 0.5) * 2 * detune;
      const offset = Math.random() * buf.duration * 0.4;
      const dur = (buf.duration - offset) / rate;
      const f = Math.min(fade, dur * 0.45);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.setValueCurveAtTime(RAMP_UP, at, f);
      g.gain.setValueCurveAtTime(RAMP_DOWN, at + dur - f, f);
      src.connect(g).connect(bus);
      src.start(at, offset);
      src.stop(at + dur + 0.05);
      return at + dur - f;
    }

    return {
      // 0..1. Ramped rather than assigned: writing an AudioParam every frame is
      // a staircase, and on a wideband noise bed a staircase is audible.
      level(v) { want = Math.max(0, Math.min(1, v)) * gain; },
      step() {
        if (stopped || !ctx || ctx.state !== 'running') return;
        const t = ctx.currentTime;
        for (const lane of lanes) {
          if (t >= lane.due) lane.due = launch(lane, Math.max(t, lane.due));
        }
        if (Math.abs(want - told) > 0.004) {
          bus.gain.setTargetAtTime(want, t, 0.25);
          told = want;
        }
      },
      stop() {
        if (stopped || !ctx) return;
        stopped = true;
        bus.gain.cancelScheduledValues(ctx.currentTime);
        bus.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      },
    };
  }

  // Everything this bank is holding, faded rather than cut. Used when the player
  // leaves first person mid-burst.
  function silence() {
    for (const [name, list] of live) for (const v of [...list]) retire(name, v, 0.08);
  }

  return {
    load,
    unlock,
    play,
    ambience,
    silence,
    has: (name) => buffers.has(name),
    get ready() { return !!ctx && ctx.state === 'running' && buffers.size > 0; },
  };
}
