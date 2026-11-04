/** Longest side an inserted image is scaled down to, to keep the file it is stored in small. */
const MAX_IMAGE = 1600;

export function pickImage() {
  const input = Object.assign(document.createElement("input"), {
    type: "file",
    accept: "image/png, image/jpeg, image/gif, image/webp",
  });
  return new Promise<File | null>((resolve) => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// shortcut: images are stored inline as data URLs, in annotations, undo steps and markdown files; move them to files beside the document if many large images get slow.
export async function shrinkImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const fit = Math.min(1, MAX_IMAGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * fit);
  canvas.height = Math.round(bitmap.height * fit);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // JPEGs stay JPEGs to keep them small; everything else may have transparency.
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return { src: canvas.toDataURL(type, 0.9), width: canvas.width, height: canvas.height };
}
