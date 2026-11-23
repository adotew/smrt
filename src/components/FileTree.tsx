import { useEffect, useMemo, useRef, useState } from "react";
import {
  dragAndDropFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  keyboardDragAndDropFeature,
  renamingFeature,
  searchFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type ItemInstance,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { Folder } from "../../electron/library.ts";
import { filesOf } from "../lib/assistant.ts";
import { contextMenu, type MenuItem } from "./ContextMenu.tsx";
import EmptyState from "./EmptyState.tsx";
import FileIcon from "./FileIcon.tsx";
import Icon from "./Icon.tsx";
import { fileType } from "./Pane.tsx";

const api = window.smrt;
const ROOT_ID = "__root__";

interface TreeNode {
  id: string;
  name: string;
  kind: "root" | "folder" | "file";
  children: string[];
}

/** What the toolbar's add button and a folder's context menu both offer. */
export const addToFolderItems: MenuItem[] = [
  { id: "folder", label: "New Folder…" },
  { type: "separator" },
  { id: "import", label: "Import PDF…" },
  { id: "markdown", label: "New Markdown File…" },
  { id: "deck", label: "New Flashcard Deck…" },
];

export function addToFolder(
  choice: string | null,
  target: string,
  actions: Pick<FileTreeProps, "onNewFolder" | "onImportPDF" | "onNewFile">,
) {
  if (choice === "folder") actions.onNewFolder(target);
  else if (choice === "import") actions.onImportPDF(target);
  else if (choice === "markdown") actions.onNewFile(target, "md");
  else if (choice === "deck") actions.onNewFile(target, "cards");
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function buildNodes(folders: Folder[]): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  nodes.set(ROOT_ID, {
    id: ROOT_ID,
    name: "Library",
    kind: "root",
    children: folders.map((f) => f.path),
  });
  const visit = (folder: Folder) => {
    const files = filesOf(folder).sort(byName);
    nodes.set(folder.path, {
      id: folder.path,
      name: folder.name,
      kind: "folder",
      children: [...folder.folders.map((f) => f.path), ...files.map((f) => f.path)],
    });
    for (const child of folder.folders) visit(child);
    for (const file of files) {
      nodes.set(file.path, { id: file.path, name: file.name, kind: "file", children: [] });
    }
  };
  for (const folder of folders) visit(folder);
  return nodes;
}

/** Drops any item whose ancestor is already in the list, so moving/trashing a folder doesn't also act on its children. */
function topLevelItems(items: ItemInstance<TreeNode>[]): ItemInstance<TreeNode>[] {
  const ids = new Set(items.map((item) => item.getId()));
  return items.filter((item) => {
    let parent = item.getParent();
    while (parent && parent.getId() !== ROOT_ID) {
      if (ids.has(parent.getId())) return false;
      parent = parent.getParent();
    }
    return true;
  });
}

function RenameInput({ item }: { item: ItemInstance<TreeNode> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const props = item.getRenameInputProps();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const name = el.value;
    const dot = item.isFolder() ? -1 : name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [item]);

  return (
    <input
      {...props}
      ref={inputRef}
      className="rename-input"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

export interface FileTreeProps {
  folders: Folder[];
  expanded: string[];
  onExpandedChange: (expanded: string[]) => void;
  activeFile: string | null;
  activeFolder: string | null;
  onSelectFolder: (folderPath: string | null) => void;
  onOpenFile: (filePath: string, beside?: boolean) => void;
  onRename: (path: string, kind: "folder" | "file", newName: string) => Promise<void>;
  onMove: (sources: string[], targetFolder: string | null) => Promise<void>;
  onDropExternalFiles: (files: File[], targetFolder: string) => Promise<void>;
  onTrash: (targets: { path: string; kind: "folder" | "file" }[]) => Promise<void>;
  onNewFolder: (parent?: string) => void;
  onImportPDF: (folderPath: string) => void;
  onNewFile: (folderPath: string, type: "md" | "cards") => void;
  onEditCards: (filePath: string) => void;
}

export default function FileTree(props: FileTreeProps) {
  const { folders, expanded, activeFile, activeFolder } = props;
  const nodes = useMemo(() => buildNodes(folders), [folders]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const propsRef = useRef(props);
  propsRef.current = props;

  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [rootDragOver, setRootDragOver] = useState(false);

  const tree = useTree<TreeNode>({
    rootItemId: ROOT_ID,
    getItemName: (item) => item.getItemData()?.name ?? "",
    isItemFolder: (item) => {
      const kind = item.getItemData()?.kind;
      return kind === "root" || kind === "folder";
    },
    dataLoader: {
      getItem: (id) => nodesRef.current.get(id) ?? { id, name: "", kind: "file", children: [] },
      getChildren: (id) => nodesRef.current.get(id)?.children ?? [],
    },
    state: {
      expandedItems: expanded,
      selectedItems,
    },
    setExpandedItems: (updater) => {
      const current = propsRef.current.expanded;
      const next = typeof updater === "function" ? updater(current) : updater;
      propsRef.current.onExpandedChange(next);
    },
    setSelectedItems,
    canReorder: false,
    openOnDropDelay: 500,
    canDrag: (items) => items.length > 0 && items.every((item) => item.getId() !== ROOT_ID),
    canDrop: (items, target) => {
      const targetId = target.item.getId();
      const targetNode = nodesRef.current.get(targetId);
      if (!targetNode || targetNode.kind === "file") return false;
      if (targetId === ROOT_ID) {
        return (
          items.every((item) => item.isFolder()) &&
          items.some((item) => item.getParent()?.getId() !== ROOT_ID)
        );
      }
      if (items.some((item) => item.getId() === targetId || target.item.isDescendentOf(item.getId()))) {
        return false;
      }
      if (items.every((item) => item.getParent()?.getId() === targetId)) {
        return false;
      }
      return true;
    },
    onDrop: async (items, target) => {
      setRootDragOver(false);
      const top = topLevelItems(items);
      if (!top.length) return;
      const targetId = target.item.getId();
      const targetFolder = targetId === ROOT_ID ? null : targetId;
      await propsRef.current.onMove(
        top.map((item) => item.getId()),
        targetFolder,
      );
      if (targetFolder && !propsRef.current.expanded.includes(targetFolder)) {
        propsRef.current.onExpandedChange([...propsRef.current.expanded, targetFolder]);
      }
    },
    canDragForeignDragObjectOver: (dataTransfer, target) => {
      const targetId = target.item.getId();
      return (
        targetId !== ROOT_ID &&
        target.item.isFolder() &&
        Array.from(dataTransfer.types).includes("Files")
      );
    },
    canDropForeignDragObject: (dataTransfer, target) => {
      const targetId = target.item.getId();
      return targetId !== ROOT_ID && target.item.isFolder() && dataTransfer.files.length > 0;
    },
    onDropForeignDragObject: async (dataTransfer, target) => {
      setRootDragOver(false);
      const targetId = target.item.getId();
      if (targetId === ROOT_ID || !target.item.isFolder()) return;
      const files = Array.from(dataTransfer.files);
      if (!files.length) return;
      await propsRef.current.onDropExternalFiles(files, targetId);
      if (!propsRef.current.expanded.includes(targetId)) {
        propsRef.current.onExpandedChange([...propsRef.current.expanded, targetId]);
      }
    },
    canRename: (item) => item.getId() !== ROOT_ID,
    onRename: (item, value) => {
      const kind = item.isFolder() ? "folder" : "file";
      const trimmed = value.trim();
      if (!trimmed || trimmed === item.getItemName()) return;
      void propsRef.current.onRename(item.getId(), kind, trimmed);
    },
    onPrimaryAction: (item) => {
      if (item.getId() === ROOT_ID) return;
      if (item.isFolder()) {
        propsRef.current.onSelectFolder(item.getId());
      } else if (tree.getSelectedItems().length <= 1) {
        propsRef.current.onOpenFile(item.getId());
      }
    },
    hotkeys: {
      customDelete: {
        hotkey: api.platform === "darwin" ? "Meta+Backspace" : "Delete",
        preventDefault: true,
        handler: (_e, instance) => {
          const selected = topLevelItems(instance.getSelectedItems().filter((i) => i.getId() !== ROOT_ID));
          if (!selected.length) return;
          void propsRef.current.onTrash(
            selected.map((i) => ({ path: i.getId(), kind: i.isFolder() ? "folder" : "file" })),
          );
        },
      },
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      keyboardDragAndDropFeature,
      renamingFeature,
      searchFeature,
      expandAllFeature,
    ],
  });

  useEffect(() => {
    tree.rebuildTree();
    // Moved, renamed or trashed items would otherwise stay selected under paths that no longer exist.
    setSelectedItems((selected) => {
      const kept = selected.filter((id) => nodes.has(id));
      return kept.length === selected.length ? selected : kept;
    });
  }, [nodes, tree]);

  async function openItemMenu(item: ItemInstance<TreeNode>) {
    const id = item.getId();
    const currentSelected = tree.getSelectedItems().filter((i) => i.getId() !== ROOT_ID);
    const inSelection = currentSelected.some((i) => i.getId() === id);
    const targets = inSelection && currentSelected.length > 1 ? topLevelItems(currentSelected) : [item];
    if (!inSelection) {
      tree.setSelectedItems([id]);
      item.setFocused();
    }

    if (targets.length > 1) {
      const choice = await contextMenu([{ id: "trash", label: `Move ${targets.length} Items to Trash` }]);
      if (choice === "trash") {
        await props.onTrash(targets.map((i) => ({ path: i.getId(), kind: i.isFolder() ? "folder" : "file" })));
      }
      return;
    }

    if (item.isFolder()) {
      props.onSelectFolder(id);
      const choice = await contextMenu([
        ...addToFolderItems,
        { type: "separator" as const },
        { id: "rename", label: "Rename" },
        { id: "trash", label: "Move to Trash" },
      ]);
      if (choice === "rename") item.startRenaming();
      else if (choice === "trash") await props.onTrash([{ path: id, kind: "folder" }]);
      else addToFolder(choice, id, props);
      return;
    }

    const choice = await contextMenu([
      ...(fileType(id) === "cards" ? [{ id: "edit", label: "Edit Cards" }] : []),
      { id: "split", label: "Open in Split View" },
      { type: "separator" as const },
      { id: "rename", label: "Rename" },
      { id: "trash", label: "Move to Trash" },
    ]);
    if (choice === "edit") props.onEditCards(id);
    else if (choice === "split") props.onOpenFile(id, true);
    else if (choice === "rename") item.startRenaming();
    else if (choice === "trash") await props.onTrash([{ path: id, kind: "file" }]);
  }

  async function openRootMenu(event: React.MouseEvent) {
    if ((event.target as HTMLElement).closest(".row")) return;
    const choice = await contextMenu([{ id: "folder", label: "New Folder…" }]);
    if (choice === "folder") props.onNewFolder();
  }

  if (folders.length === 0) {
    return <EmptyState icon="newFolder" title="Create a folder" action={{ label: "New Folder", run: () => props.onNewFolder() }} />;
  }

  const containerProps = tree.getContainerProps("Library");
  const isSearchOpen = tree.isSearchOpen();
  const matchingCount = isSearchOpen ? tree.getSearchMatchingItems().length : 0;
  const dragTargetId = tree.getDragTarget()?.item.getId();
  const showRootDrop = rootDragOver && (!dragTargetId || dragTargetId === ROOT_ID);

  return (
    <div
      {...containerProps}
      className={`file-tree ${showRootDrop ? "root-drop-target" : ""}`}
      onContextMenu={openRootMenu}
      onDragOver={(e) => {
        containerProps.onDragOver?.(e);
        const dragged = tree.getState().dnd?.draggedItems;
        const canDropRoot =
          !!dragged?.length &&
          dragged.every((i) => i.isFolder()) &&
          dragged.some((i) => i.getParent()?.getId() !== ROOT_ID);
        setRootDragOver(canDropRoot);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRootDragOver(false);
      }}
      onDrop={(e) => {
        setRootDragOver(false);
        containerProps.onDrop?.(e);
      }}
    >
      {isSearchOpen && (
        <div className="tree-search">
          <input {...tree.getSearchInputElementProps()} className="tree-search-input" placeholder="Filter…" autoFocus />
          <span className="tree-search-count">{matchingCount}</span>
          <button type="button" className="tree-search-close" aria-label="Close filter" onClick={() => tree.closeSearch()}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {tree.getItems().map((item) => {
        const id = item.getId();
        const isFolder = item.isFolder();
        const open = isFolder && item.isExpanded();
        const isActive = isFolder ? activeFolder === id && !activeFile : activeFile === id;
        const isSelected = item.isSelected();
        const isDropTarget = item.isDragTarget();
        const isMatch = isSearchOpen && item.isMatchingSearch();
        const level = item.getItemMeta().level;
        const itemProps = item.getProps();

        return (
          <div
            {...itemProps}
            key={item.getKey()}
            className={`row ${isFolder ? "folder" : "file"} ${isActive || isSelected ? "selected" : ""} ${isDropTarget ? "drop-target" : ""} ${isMatch ? "search-match" : ""}`}
            style={{ paddingLeft: `${level * 14 + (isFolder ? 6 : 10)}px` }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void openItemMenu(item);
            }}
          >
            {isFolder ? (
              <span className={`chevron ${open ? "open" : ""}`}>
                <Icon name="chevronRight" size={12} />
              </span>
            ) : (
              <FileIcon type={fileType(id)} size={22} />
            )}
            {item.isRenaming() ? <RenameInput item={item} /> : <span className="label">{item.getItemName()}</span>}
          </div>
        );
      })}
    </div>
  );
}
