import { useEffect, useRef } from "react";
import { allFiles, useAssistant } from "../lib/assistant.ts";
import FileIcon from "./FileIcon.tsx";
import { fileType } from "./Pane.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

const baseName = (name: string) => name.replace(/\.(pdf|md|cards|quiz|html)$/i, "");

/** ⌘P: jumps to any file in the library by name, with recently opened files first. */
export default function QuickOpen({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (path: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { library, recent } = useAssistant();

  useEffect(() => {
    const element = dialog.current!;
    if (open && !element.open) {
      element.showModal();
      // showModal() focuses cmdk's root, which is focusable but takes no typing.
      element.querySelector("input")?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);

  const rank = (path: string) => {
    const index = recent.indexOf(path);
    return index < 0 ? Infinity : index;
  };
  const files = allFiles(library).sort((a, b) => rank(a.path) - rank(b.path));

  return (
    <dialog
      ref={dialog}
      className="quick-open"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {/* Mounted only while open, so each opening starts with an empty query. */}
      {open && (
        <Command loop label="Go to File">
          <CommandInput placeholder="Go to file…" />
          <CommandList>
            <CommandEmpty>No matching files</CommandEmpty>
            {files.map((file) => (
              // The name comes first so it outranks folder names when scoring.
              <CommandItem
                key={file.path}
                value={`${file.name} ${file.folder}`}
                className="rounded-lg data-selected:bg-(--hover)"
                onSelect={() => {
                  dialog.current!.close();
                  onOpen(file.path);
                }}
              >
                <FileIcon type={fileType(file.path)} size={16} />
                <span className="truncate">{baseName(file.name)}</span>
                <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{file.folder}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
    </dialog>
  );
}
