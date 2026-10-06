export function ReviewShortcuts({
  actions,
}: {
  actions: Array<[string, string]>;
}) {
  return (
    <div className="review-shortcuts" aria-label="Keyboard shortcuts">
      <strong>Shortcuts</strong>
      {actions.map(([key, label]) => (
        <span key={key}>
          <kbd>{key}</kbd> {label}
        </span>
      ))}
      <small>Letter shortcuts work outside form fields.</small>
    </div>
  );
}
