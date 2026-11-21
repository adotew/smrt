import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAssistant } from "../lib/assistant.ts";
import Deck, { type DeckHandle } from "../views/Deck.tsx";
import Html from "../views/Html.tsx";
import { IconButton } from "./Icon.tsx";
import { WarmTooltipGroup } from "@/components/ui/warm-tooltip";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import QuizFile from "../views/QuizFile.tsx";
import Reader, { type ReaderHandle } from "../views/Reader.tsx";
import { grow } from "../lib/transitions.ts";

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
  onerror,
}: {
  ref?: Ref<PaneHandle>;
  path: string;
  /** The pane the sidebar and menu commands act on. */
  active: boolean;
  onerror: (error: unknown) => void;
}) {
  const [showingNotes, setShowingNotes] = useState(false);
  const [placingNote, setPlacingNote] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const reader = useRef<ReaderHandle>(null);
  const markdown = useRef<MarkdownEditorHandle>(null);
  const deck = useRef<DeckHandle>(null);
  const { edits } = useAssistant();

  const type = fileType(path);
  const pdfPath = type === "pdf" ? path : null;
  const revision = edits[path] ?? 0;
  // Reloads once the assistant writes the file.
  const key = `${path}#${revision}`;

  const toggleNotes = () => setShowingNotes((showing) => !showing);
  useImperativeHandle(ref, () => ({
    flush: () => Promise.all([reader.current?.flush(), markdown.current?.flush(), deck.current?.flush()]),
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
      {pdfPath && (
        <Reader
          ref={reader}
          path={pdfPath}
          active={active}
          showingNotes={showingNotes}
          placingNote={placingNote}
          onPlacingNoteChange={setPlacingNote}
          onEditingTextChange={setEditingText}
          onerror={onerror}
        />
      )}
      {type === "md" && <MarkdownEditor key={path} ref={markdown} path={path} revision={revision} onerror={onerror} />}
      {type === "cards" && <Deck key={path} ref={deck} path={path} revision={revision} active={active} onerror={onerror} />}
      {type === "quiz" && <QuizFile key={key} path={path} onerror={onerror} />}
      {type === "html" && <Html key={key} path={path} />}
      {/* Swaps in place with the text formatting bar, which grows in the same way. */}
      <AnimatePresence initial={false}>
        {pdfPath && !editingText && (
          <motion.div
            key="pdf-toolbar"
            className="bottom-toolbar floating"
            style={{ x: "-50%" }}
            {...grow(0.9)}
          >
            <WarmTooltipGroup>
              <IconButton tooltip name="notes" title="Notes" onClick={toggleNotes} pressed={showingNotes} />
              <IconButton
                tooltip
                name="pageNote"
                title="Add Note to Page"
                onClick={() => setPlacingNote(!placingNote)}
                pressed={placingNote}
              />
              <IconButton tooltip name="photo" title="Add Image to Page" onClick={() => reader.current?.insertImage()} />
            </WarmTooltipGroup>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
