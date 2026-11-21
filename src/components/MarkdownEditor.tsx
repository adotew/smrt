import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import Markdown, { type MarkdownHandle } from "./Markdown.tsx";

const api = window.smrt;

export interface MarkdownEditorHandle {
  /** Saves pending edits and resolves once every save has finished. */
  flush: () => Promise<void>;
  undo: () => void;
  redo: () => void;
}

export default function MarkdownEditor({
  ref,
  path,
  revision = 0,
  onerror,
}: {
  ref?: Ref<MarkdownEditorHandle>;
  path: string;
  /** Bumped when the assistant writes the file, so the editor reloads without flushing stale text over it. */
  revision?: number;
  onerror: (error: unknown) => void;
}) {
  /** Null until the file has loaded, so a file that failed to load is never overwritten. */
  const [initial, setInitial] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const text = useRef<string | null>(null);
  const editor = useRef<MarkdownHandle>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Saves run one after another so an older one never lands last. */
  const saving = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);

  function save() {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (text.current == null) return;
    const latest = text.current;
    saving.current = saving.current.then(() => api.saveMarkdown(path, latest)).catch(onerror);
  }

  function flush() {
    if (timer.current) save();
    return saving.current;
  }

  useImperativeHandle(ref, () => ({
    flush,
    undo: () => editor.current?.undo(),
    redo: () => editor.current?.redo(),
  }));

  useEffect(() => {
    const onbeforeunload = () => void flush();
    window.addEventListener("beforeunload", onbeforeunload);
    return () => {
      window.removeEventListener("beforeunload", onbeforeunload);
      flush();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reload = mounted.current;
    mounted.current = true;
    if (reload) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    (async () => {
      if (reload) await saving.current;
      try {
        const content = await api.readMarkdown(path);
        if (cancelled) return;
        text.current = content;
        setInitial(content);
        setLoaded((n) => n + 1);
      } catch (error) {
        if (!cancelled) onerror(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return (
    <div className="markdown">
      {initial != null && (
        <Markdown
          key={loaded}
          ref={editor}
          className="markdown-content"
          value={initial}
          onchange={(markdown) => {
            text.current = markdown;
            clearTimeout(timer.current);
            timer.current = setTimeout(save, 400);
          }}
          onerror={onerror}
        />
      )}
    </div>
  );
}
