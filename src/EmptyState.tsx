import Icon, { type IconName } from "./Icon.tsx";

export default function EmptyState({
  icon,
  title,
  description = null,
  action = null,
}: {
  icon: IconName;
  title: string;
  description?: string | null;
  action?: { label: string; run: () => void } | null;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={64} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <button onClick={action.run}>{action.label}</button>}
    </div>
  );
}
