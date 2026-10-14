import { gunzipSync } from "node:zlib";
import { HttpError } from "../config";

/**
 * Reads a request body with a hard cap on the bytes on the wire and, when `Content-Encoding: gzip` is declared, on the decoded
 * bytes too (a few KB of gzip must not inflate into memory). 413 over a cap, 415 for another encoding, 400 for broken gzip.
 */
export async function readCappedBody(req: Request, opts: { maxBytes: number; allowGzip: boolean }): Promise<Uint8Array> {
  const encoding = (req.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && !(encoding === "gzip" && opts.allowGzip)) throw new HttpError(415, `unsupported content-encoding ${encoding}`);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) throw new HttpError(413, `body exceeds ${opts.maxBytes} bytes`);
  if (!req.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let wire = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    wire += value.byteLength;
    if (wire > opts.maxBytes) {
      await reader.cancel();
      throw new HttpError(413, `body exceeds ${opts.maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks);
  if (encoding !== "gzip") return raw;
  try {
    return gunzipSync(raw, { maxOutputLength: opts.maxBytes });
  } catch (e) {
    if (e instanceof RangeError || (e instanceof Error && "code" in e && e.code === "ERR_BUFFER_TOO_LARGE")) {
      throw new HttpError(413, `body exceeds ${opts.maxBytes} bytes once decoded`);
    }
    throw new HttpError(400, "the body is not valid gzip");
  }
}
