import {
  uniform as objectUniform, uniformArray as objectUniformArray, renderGroup,
} from 'three/tsl';

// Uniforms that belong to the scene, not to a mesh.
//
// --- why this module exists --------------------------------------------------
//
// A TSL `uniform()` lands in the *object* group by default, and that default is
// wrong for almost everything in this project. The object group is not shared:
// three allocates one uniform buffer per render object per material and refills
// it before that object is drawn. So a single `uniform(0)` holding the time of
// day, referenced by the ship's program, is not one 4-byte value on the GPU —
// it is one copy inside each of the nine hundred buffers belonging to the nine
// hundred meshes she is built from, and every one of those buffers is written
// again every frame.
//
// That was costing about twenty milliseconds a frame. The ship's program reads
// the shading state, the fx toggles, the damage array, the destruction field and
// the lamp rig — a couple of kilobytes of it — and all of it was being uploaded
// nine hundred times a frame to say the same thing nine hundred times.
//
// `renderGroup` is the fix and it is the accurate description as well: these
// values are properties of the frame being drawn, they are identical for every
// object that reads them, and three updates a shared group once per render pass.
// One buffer, one write.
//
// --- when NOT to use this ----------------------------------------------------
//
// A uniform whose value genuinely differs from mesh to mesh — anything with an
// `.onObjectUpdate` on it — must stay in the object group, because that is the
// only group that can hold a different answer for each object. There are three
// of those in the whole project (the ship-frame transform and the cut plane in
// boatMaterial.js, and the section plane in interior.js) and they import from
// `three/tsl` directly. Every other uniform in the project should come from
// here: if you are reaching for `uniform` and the value is the same for the
// whole scene, this is the one you want.
export function uniform(value, type) {
  return objectUniform(value, type).setGroup(renderGroup);
}

export function uniformArray(value, type) {
  return objectUniformArray(value, type).setGroup(renderGroup);
}
