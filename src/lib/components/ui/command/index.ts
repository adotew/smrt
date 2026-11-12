import Empty from "./command-empty.svelte";
import Group from "./command-group.svelte";
import Item from "./command-item.svelte";
import LinkItem from "./command-link-item.svelte";
import List from "./command-list.svelte";
import Loading from "./command-loading.svelte";
import Separator from "./command-separator.svelte";
import Shortcut from "./command-shortcut.svelte";
import Root from "./command.svelte";

export {
	Root,
	Empty,
	Group,
	Item,
	LinkItem,
	List,
	Separator,
	Shortcut,
	Loading,
	//
	Root as Command,
	Empty as CommandEmpty,
	Group as CommandGroup,
	Item as CommandItem,
	LinkItem as CommandLinkItem,
	List as CommandList,
	Separator as CommandSeparator,
	Shortcut as CommandShortcut,
	Loading as CommandLoading,
};
