/**
 * A translucent veil drawn between the graph and its highlighted items: dimming everything else
 * is one quad, whatever the graph's size, instead of a state change on every node and edge.
 */

/** Depth layers in paint order; the veil sits under the highlighted (`top*`) layers. */
export const DIM_DEPTH = "dim";
export const DEPTH_LAYERS = ["edges", "nodes", DIM_DEPTH, "topEdges", "topNodes"] as const;

export interface DimLayer {
  render(): void;
  kill(): void;
}

const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 color;
out vec4 fragColor;
void main() { fragColor = color; }`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`dim layer shader: ${gl.getShaderInfoLog(shader) ?? "did not compile"}`);
  }
  return shader;
}

/**
 * The veil's factory for `Sigma.addCustomLayerProgram`. `color` returns straight (not
 * premultiplied) RGBA in 0..1; nothing is drawn while `active` is false.
 */
export function dimLayer(
  active: () => boolean,
  color: () => readonly [number, number, number, number],
): (gl: WebGL2RenderingContext) => DimLayer {
  return (gl) => {
    const program = gl.createProgram()!;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    const colorAt = gl.getUniformLocation(program, "color");
    const positionAt = gl.getAttribLocation(program, "position");

    // Its own vertex array, so Sigma's attribute bindings are never touched.
    const vertices = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vertices);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(positionAt);
    gl.vertexAttribPointer(positionAt, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return {
      render() {
        if (!active()) return;
        const [r, g, b, a] = color();
        gl.useProgram(program);
        gl.bindVertexArray(vertices);
        // Sigma blends premultiplied colours (ONE, ONE_MINUS_SRC_ALPHA).
        gl.uniform4f(colorAt, r * a, g * a, b * a, a);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindVertexArray(null);
      },
      kill() {
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vertices);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
      },
    };
  };
}

/** Any CSS colour as RGBA in 0..1, through the browser's own parser. */
export function cssColor(value: string, alpha: number): [number, number, number, number] {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return [0, 0, 0, alpha];
  context.fillStyle = value;
  // The browser normalises to `#rrggbb`, or `rgba(...)` for translucent and wide-gamut input.
  const parsed = String(context.fillStyle);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(parsed);
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(parsed);
  let channels = [0, 0, 0];
  if (hex) channels = [hex[1]!, hex[2]!, hex[3]!].map((part) => parseInt(part, 16));
  else if (rgb) channels = [rgb[1]!, rgb[2]!, rgb[3]!].map(Number);
  return [channels[0]! / 255, channels[1]! / 255, channels[2]! / 255, alpha];
}
