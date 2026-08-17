// Which slots of a particle buffer the GPU actually needs this frame.
//
// three's WebGPU backend has one rule about `BufferAttribute.needsUpdate`: set
// it and the whole array goes to `device.queue.writeBuffer`, every frame, no
// matter how much of it changed. That is fine for a buffer you rewrite anyway
// and ruinous for a particle pool, which is sized for the worst case and idle
// almost all of the time. Measured in this scene, the three pools between them —
// 30 000 droplets of hull spray, 4 000 of smoke, 3 000 of shell splash — were
// pushing 1.35 MB across the bus every frame with three hundred particles alive
// between them, and it cost more than drawing them did. It is the reason the
// frame rate sagged the moment anything was under way or on fire: the pools were
// never actually idle, because their `update` marked the buffers dirty even on
// the frame where it found nothing to integrate.
//
// The fix is to describe the live slots instead. A ring buffer's live set is one
// contiguous run nearly all the time, and two just after the cursor wraps, so a
// handful of ranges covers it exactly. `addUpdateRange` is in array elements,
// hence the multiply by the attribute's item size.
//
// Runs are merged across small gaps rather than being tracked exactly. The live
// set is not actually contiguous — lifetimes are randomised per particle, so
// they die out of order and punch holes in the ring — and tracking every hole
// exactly costs more runs than the pool has slack. Merging across a gap of
// `mergeGap` re-uploads a few dead slots, which is free, and keeps the run count
// down near one or two. Without it a fragmented pool overflowed the run list
// every frame and fell back to writing the whole buffer, which is the thing this
// exists to avoid.
//
// If the live set is *still* more fragmented than `maxRuns`, it collapses to one
// range over everything — exactly the old behaviour, and still correct.
export function createDirtyRanges(count, { maxRuns = 32, mergeGap = 64 } = {}) {
  const start = new Int32Array(maxRuns);
  const end = new Int32Array(maxRuns);
  let runs = 0;
  let whole = false; // set once the run list overflows: send the lot

  return {
    // Note slot `i` as changed. Cheapest when called in ascending order, which
    // is how every integrator here walks its pool.
    mark(i) {
      if (whole) return;
      if (runs > 0 && i <= end[runs - 1] + mergeGap) {
        if (i > end[runs - 1]) end[runs - 1] = i;
        return;
      }
      if (runs === maxRuns) { whole = true; return; }
      start[runs] = i;
      end[runs] = i;
      runs++;
    },
    // True if anything at all changed — the caller can then skip the upload
    // entirely rather than handing three a clean buffer and being charged for it.
    get dirty() { return whole || runs > 0; },
    // Hand the runs to every attribute that shares this pool's indexing.
    flush(...attributes) {
      if (!whole && runs === 0) return;
      for (const attr of attributes) {
        const stride = attr.itemSize;
        if (whole) {
          attr.addUpdateRange(0, count * stride);
        } else {
          for (let k = 0; k < runs; k++) {
            attr.addUpdateRange(start[k] * stride, (end[k] - start[k] + 1) * stride);
          }
        }
        attr.needsUpdate = true;
      }
      runs = 0;
      whole = false;
    },
  };
}
