/** Bundled as text by esbuild's css loader in scripts/electron.ts. */
declare module "*.css" {
  const text: string;
  export default text;
}

/** Bundled as text by esbuild's text loader in scripts/electron.ts. */
declare module "*.md" {
  const text: string;
  export default text;
}
