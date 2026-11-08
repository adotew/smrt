/** Bundled as text by esbuild's css loader in scripts/electron.ts. */
declare module "*.css" {
  const text: string;
  export default text;
}
