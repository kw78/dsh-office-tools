/**
 * Intrinsic image dimensions from file headers (1.0.0). PNG, JPEG, and GIF
 * expose their pixel size in the first few hundred of bytes, so the linked
 * image placement can default to natural size — and compute contain/cover
 * crops — by reading the workspace file through the official fs channel and
 * inspecting bytes directly. No image decoder, no dependency, no signal.
 */
/** Returned dimensions in pixels; undefined when the bytes are not a recognized image. */
export interface ImageSize {
    width: number;
    height: number;
}
/** Sniff the pixel size of a PNG/JPEG/GIF byte buffer; undefined otherwise. */
export declare function sniffImageSize(bytes: Uint8Array): ImageSize | undefined;
