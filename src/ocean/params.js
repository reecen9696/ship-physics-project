// Single source of truth for tunable parameters. The lil-gui panel (step 6)
// binds to this object; the compute passes and render loop read from it.
//
// The spectrum model follows gasgiant/FFT-Ocean (MIT), which implements
// Horvath 2015, "Empirical Directional Wave Spectra for Computer Graphics":
// JONSWAP amplitude (from fetch + wind speed) x TMA depth correction x
// Donelan-Banner directional spreading x short-wave fade, summed over a local
// wind-sea spectrum and a swell spectrum.

export const params = {
  // --- simulation grid ---
  N: 256, // FFT resolution (power of two; 512 supported)
  cascades: 3, // number of wave cascades (1-3)
  lengthScales: [250, 17, 5], // patch size (meters) of each cascade
  boundaryFactor: 6, // wavenumber hand-off between cascades (2*pi/L_next * factor)

  // --- physics ---
  g: 9.81,
  depth: 500, // water depth (meters); large = deep-water dispersion
  lambda: 1.3, // choppiness (horizontal displacement scale)

  // --- local wind sea spectrum ---
  local: {
    scale: 1.0,
    windSpeed: 16.0, // m/s
    windDirection: 45, // degrees
    fetch: 100000, // meters
    spreadBlend: 1.0, // 0 = isotropic-ish, 1 = fully directional
    swell: 0.2, // 0-1
    peakEnhancement: 3.3, // JONSWAP gamma
    shortWavesFade: 0.02, // suppression of small wavelengths
  },

  // --- swell spectrum (longer, more directional, slower) ---
  swell: {
    scale: 0.8,
    windSpeed: 2.0,
    windDirection: 70,
    fetch: 300000,
    spreadBlend: 1.0,
    swell: 1.0,
    peakEnhancement: 3.3,
    shortWavesFade: 0.01,
  },

  // --- animation / view ---
  timeScale: 1.0,
  amplitude: 1.0, // (step-1 sine-ocean view only)
  patchSize: 1000, // (step-1 sine-ocean view only)
  sunAzimuth: 135,
  sunElevation: 28,

  // --- shading (step 5) ---
  sssStrength: 1.0,
  colors: {
    deep: 0x071a26, // deep water body
    scatter: 0x2e8f8f, // subsurface / crest scatter (teal)
    sun: 0xfff1dc, // sun disc + specular
    skyHorizon: 0x9fb8cc,
    skyZenith: 0x2a5b9c,
    foam: 0xdce7ea, // whitecaps
  },

  // --- foam (step 6) ---
  foamThreshold: 0.4, // accumulated-Jacobian value below which foam appears (lower = only real breaks)
  foamScale: 2.5, // foam coverage falloff
  foamDecay: 0.4, // foam recovery rate (lower = foam lingers/dissipates longer)

  // --- contact with solid bodies ---
  contactFoam: 1.0, // strength of the foam where the sea meets the hull
  contactFoamWidth: 0.5, // metres from the hull over which it fades out
  wakeLength: 0.6, // seconds of headway the wash trails aft of the transom

  // --- tone ---
  exposure: 0.82, // scene exposure before the tone curve

  // --- cost ---------------------------------------------------------------
  // Device pixels per CSS pixel. The single biggest lever on the frame rate,
  // because this scene is fragment-bound and has been all along: the sea is a
  // full-screen surface with a long shader on it — three cascades of maps, an
  // analytic sky reflection, subsurface, and a wash term per hull — so the cost
  // is very nearly linear in the number of pixels it is asked to fill. Measured
  // here, going from 2 to 1 roughly halves the whole render pass.
  //
  // 1 rather than 1.5, and the reason is that it is not a third of the frame,
  // it is the whole argument about the frame.
  //
  // Measured on deck at night, which is the heaviest thing this scene draws:
  // 16.2 ms at 1.5, 11.5 ms at 1.25, 7.3 ms at 1. It scales as the square of
  // this number to three significant figures, because after the draw calls were
  // brought under control there is nothing left in the frame that is not
  // fragment work. At 1.5 the GPU alone cannot hold sixty frames a second; at 1
  // it has twice the budget it needs.
  //
  // What is given up is supersampling, not antialiasing: the renderer runs 4x
  // MSAA (see `antialias` in main.js), which still resolves every geometric edge
  // — the rails, the rigging, the horizon. What goes is the smoothing MSAA
  // cannot do, which is on the *shading* rather than the silhouette, and on this
  // scene that means the specular sparkle on the sea gets busier.
  //
  // Put it to 1.5 or 2 for stills, where none of that costs anything.
  renderScale: 1,

  // --- time of day -------------------------------------------------------
  // Not a renderer switch: the whole scene is already shaded from one set of
  // uniforms, so a time of day is just different values written into them.
  //
  // Three keys rather than a day/night pair, because first light is not the
  // midpoint of the other two. Dawn's signature is a *warm* horizon under a
  // cool zenith — the opposite colour relationship to noon, where the horizon
  // is the cooler of the pair — and lerping between night and day gives you
  // neither, just a flat blue-grey. It has to be keyed in its own right.
  //
  // `timeOfDay` runs 0 = night, 0.45 = first light, 1 = full day, and
  // setTimeOfDay interpolates between whichever two keys bracket it.
  timeOfDay: 0, // starts at night; the Sun & sky folder has the slider
  timeKeys: [
    {
      at: 0.0,
      name: 'night',
      night: 1.0, // how far up every lamp on the ship is turned
      sunAzimuth: 205,
      sunElevation: 34, // the moon, high enough to lay a path on the water
      exposure: 1.35,
      sssStrength: 0.25,
      fog: 0.0016,
      colors: {
        deep: 0x01030a,
        scatter: 0x0a2333,
        sun: 0x2e3a58, // moonlight: dim and cool
        skyHorizon: 0x0e1626,
        skyZenith: 0x03050d,
        foam: 0x6b7a8c,
      },
    },
    {
      at: 0.45,
      name: 'first light',
      night: 0.5, // lamps still burning, but the sky is coming up
      sunAzimuth: 96, // low in the east
      sunElevation: 1.6, // barely clear of the horizon
      exposure: 1.0,
      sssStrength: 0.55,
      fog: 0.0019,
      colors: {
        deep: 0x050f18,
        scatter: 0x1c4f5d,
        // Warm, but not as saturated as the sky it comes from. The sun colour
        // multiplies the hull's own paint, so a strongly orange one does not
        // *light* grey steel, it dyes it — and the ship comes out the colour of
        // sand. Pulling the saturation out leaves warm light on grey plating,
        // which is what dawn actually looks like on a ship.
        sun: 0x9c8270,
        skyHorizon: 0x6b5860, // a dim rose at the rim; cool enough not to read as dust
        skyZenith: 0x0e1b32, // still night overhead
        foam: 0x94979c,
      },
    },
    {
      at: 1.0,
      name: 'day',
      night: 0.0,
      sunAzimuth: 135,
      sunElevation: 28,
      exposure: 0.82,
      sssStrength: 1.0,
      fog: 0.0020,
      colors: {
        deep: 0x071a26,
        scatter: 0x2e8f8f,
        sun: 0xfff1dc,
        skyHorizon: 0x9fb8cc,
        skyZenith: 0x2a5b9c,
        foam: 0xdce7ea,
      },
    },
  ],

  // --- how the hull's plating answers light ---------------------------------
  // Global scales over the per-part values baked into each mesh by `paint()`.
  // A ship is rolled steel under a coat of paint, and the three numbers that
  // decide whether it reads that way rather than as grey plastic are: how much
  // of the plate shows through the coat, how far the rolling direction stretches
  // its highlights, and how much the film on it disperses the sun. See
  // src/boat/metal.js for what each one does.
  hull: {
    metalness: 0.85, // 0 = every part reads as its paint, 1 = as bare plate
    anisotropy: 0.7, // 0 = round highlights, → 1 = smeared fore-and-aft
    dispersion: 0.09, // wavelength split across the sun's highlight
  },

  // --- detail ---
  detailStrength: 0.1, // sub-grid normal-noise amount (breaks up uniformity)
};
