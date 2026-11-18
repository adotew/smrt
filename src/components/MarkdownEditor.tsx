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
  onerror,
}: {
  ref?: Ref<MarkdownEditorHandle>;
  path: string;
  onerror: (error: unknown) => void;
}) {
  /** Null until the file has loaded, so a file that failed to load is never overwritten. */
  const [initial, setInitial] = useState<string | null>(null);
  const text = useRef<string | null>(null);
  const editor = useRef<MarkdownHandle>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Saves run one after another so an older one never lands last. */
  const saving = useRef<Promise<void>>(Promise.resolve());

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
    (async () => {
      try {
        text.current = await api.readMarkdown(path);
        setInitial(text.current);
      } catch (error) {
        onerror(error);
      }
    })();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  return (
    <div className="markdown">
      {initial != null && (
        <Markdown
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
