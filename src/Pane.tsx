import { useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import Assistant from "./Assistant.tsx";
import { useAssistant } from "./assistant.ts";
import Deck, { type DeckHandle } from "./Deck.tsx";
import Html from "./Html.tsx";
import { IconButton } from "./Icon.tsx";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import QuizFile from "./QuizFile.tsx";
import Reader, { type ReaderHandle } from "./Reader.tsx";
import { grow } from "./transitions.ts";

export interface PaneHandle {
  /** Lets pending markdown and deck saves land before their file moves. */
  flush: () => Promise<unknown>;
  toggleNotes: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoom: (scale: number | null) => void;
  undo: () => void;
  redo: () => void;
  startEditing: () => void;
}

export const fileType = (path: string) =>
  /\.md$/i.test(path) ? "md" : /\.cards$/i.test(path) ? "cards" : /\.quiz$/i.test(path) ? "quiz" : /\.html$/i.test(path) ? "html" : "pdf";

export default function Pane({
  ref,
  path,
  active,
  inset,
  context,
  docked,
  onerror,
  onopen,
  onpin,
}: {
  ref?: Ref<PaneHandle>;
  path: string | null;
  /** The file the assistant looks at: this pane's, or the one beside an empty pane. */
  context: string | null;
  /** Whether an open file gets the floating assistant; off while the chat has a pane of its own. */
  docked: boolean;
  /** The pane the sidebar and menu commands act on. */
  active: boolean;
  /** Width on the left covered by the floating sidebar. */
  inset: number;
  onerror: (error: unknown) => void;
  onopen: (path: string, beside?: boolean) => void;
  onpin: () => void;
}) {
  const [showingNotes, setShowingNotes] = useState(false);
  const [placingNote, setPlacingNote] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const reader = useRef<ReaderHandle>(null);
  const markdown = useRef<MarkdownEditorHandle>(null);
  const deck = useRef<DeckHandle>(null);
  const { edits } = useAssistant();

  const type = path && fileType(path);
  const pdfPath = type === "pdf" ? path : null;
  // Reloads once the assistant writes the file.
  const key = `${path}#${(path && edits[path]) ?? 0}`;

  const toggleNotes = () => setShowingNotes((showing) => !showing);
  useImperativeHandle(ref, () => ({
    flush: () => Promise.all([markdown.current?.flush(), deck.current?.flush()]),
    toggleNotes,
    zoomIn: () => reader.current?.zoomIn(),
    zoomOut: () => reader.current?.zoomOut(),
    zoom: (scale) => reader.current?.zoom(scale),
    undo: () => (type === "md" ? markdown.current?.undo() : reader.current?.undo()),
    redo: () => (type === "md" ? markdown.current?.redo() : reader.current?.redo()),
    startEditing: () => deck.current?.startEditing(),
  }));

  return (
    <>
      <Reader
        ref={reader}
        path={pdfPath}
        showingNotes={showingNotes}
        placingNote={placingNote}
        onPlacingNoteChange={setPlacingNote}
        onEditingTextChange={setEditingText}
        inset={inset}
        onerror={onerror}
      />
      {path && type === "md" && <MarkdownEditor key={key} ref={markdown} path={path} inset={inset} onerror={onerror} />}
      {path && type === "cards" && <Deck key={key} ref={deck} path={path} active={active} inset={inset} onerror={onerror} />}
      {path && type === "quiz" && <QuizFile key={key} path={path} inset={inset} onerror={onerror} />}
      {path && type === "html" && <Html key={key} path={path} inset={inset} />}
      {/* Swaps in place with the text formatting bar, which grows in the same way. */}
      <AnimatePresence initial={false}>
        {pdfPath && !editingText && (
          <motion.div
            key="pdf-toolbar"
            className="bottom-toolbar floating"
            style={{ "--inset": `${inset}px`, x: "-50%" } as CSSProperties}
            {...grow(0.9)}
          >
            <IconButton name="notes" title="Notes" onClick={toggleNotes} pressed={showingNotes} />
            <IconButton name="pageNote" title="Add Note to Page" onClick={() => setPlacingNote(!placingNote)} pressed={placingNote} />
            <IconButton name="photo" title="Add Image to Page" onClick={() => reader.current?.insertImage()} />
          </motion.div>
        )}
      </AnimatePresence>
      {!path ? (
        <Assistant key="page" mode="page" context={context} active={active} inset={inset} onopen={onopen} />
      ) : (
        docked && <Assistant key="dock" mode="dock" context={context} active={active} onopen={onopen} onpin={onpin} />
      )}
    </>
  );
}
