export default function Html({ path }: { path: string }) {
  // Served by the smrt-file protocol in main.ts, so the page's relative links resolve within the library.
  const src = `smrt-file://library/${path.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/")}`;
  return (
    <div className="markdown">
      {/* Without allow-same-origin the page can't reach window.smrt in the app. */}
      <iframe
        className="html-page"
        title={path.split(/[\\/]/).pop()}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        src={src}
      ></iframe>
    </div>
  );
}
