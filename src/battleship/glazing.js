import { MeshBasicNodeMaterial, DoubleSide } from 'three/webgpu';
import {
  Fn, vec3, vec4, float, normalize, dot, saturate, abs, max, pow, reflect,
  cameraPosition, positionWorld, normalWorld,
} from 'three/tsl';
import { skyColor } from '../ocean/sky.js';

// Glass you can actually see through.
//
// The ship already has a window program (see `glass` in shipMaterial.js) and it
// is deliberately opaque: a window band seen from half a mile is a reflection
// with a suggestion of a lit room behind it, and painting that is both cheaper
// and more convincing than drawing the room. That is the right answer for every
// window on her — except the one you stand behind.
//
// A wheelhouse is a room you con the ship from, so its windows have exactly one
// job: to show you the sea. That makes them the one surface on the ship that has
// to be genuinely transparent, in both directions — you look out through them
// from the wheel, and you look in through them from the platform outside.
//
// So: a real transparent pass. Almost nothing of its own colour, a fresnel
// reflection of the sky that goes from nearly nothing head-on to a hard sheet at
// a glancing angle, and an alpha that follows the same curve — which is what
// makes a pane read as glass rather than as a hole. `depthWrite` is off, because
// a pane that writes depth hides whatever is behind it from every transparent
// thing drawn after it, and there are two panes between the helmsman and the
// horizon at any bearing.
//
// The frames, mullions and sills are not drawn here. They are steel, they are
// opaque, and they are part of the wheelhouse's own plating — see wheelhouse.js.
// Keeping them out of the glass means this program is only ever asked about
// glass, and the frame never has to be faked with an alpha ramp.
export function createClearGlass({ shading }) {
  const mat = new MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  // A pane is a sheet, and it is looked at from both sides — from the wheel and
  // from the platform outside it.
  mat.side = DoubleSide;

  mat.colorNode = Fn(() => {
    const N = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(positionWorld));
    // `abs`, because the far pane of the band is facing away from the eye and a
    // signed dot would give it a full-strength grazing reflection while it is
    // being looked at square on.
    const facing = saturate(abs(dot(N, V)));
    const fres = float(0.04).add(float(0.96).mul(pow(float(1).sub(facing), 5)));

    // What the pane reflects. Held off the horizon so a downward-facing normal
    // (the eye above the band, looking down through it) reflects sky rather than
    // the black under the world.
    const R = reflect(V.negate(), N);
    const sky = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z)), shading, float(1));

    // The glass itself: a green-grey cast, the colour of thick plate glass seen
    // edge-on, and nothing else. Everything else you see through this surface is
    // whatever was drawn behind it.
    const body = vec3(0.030, 0.042, 0.040);
    const col = body.add(sky.mul(fres.mul(0.9)));
    // Clear head-on, a mirror at a glancing angle. The floor is what keeps a
    // pane visible at all when you are looking straight through it — without it
    // the wheelhouse has open holes in its sides rather than windows.
    const alpha = saturate(float(0.10).add(fres.mul(0.85)));
    return vec4(col, alpha);
  })();

  return mat;
}
