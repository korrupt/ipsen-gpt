/** Shown above the composer while chat is closed: the PC is unreachable, or the host paused it. */
export function ChatClosedBanner({ message }: { message: string }) {
  return (
    <div className="chat-closed" role="status" data-testid="chat-closed">
      {message}
    </div>
  );
}
