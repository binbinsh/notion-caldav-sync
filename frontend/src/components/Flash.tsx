export function Flash({ type, message }: { type: "error" | "success"; message: string }) {
  if (!message) return null;
  const styles =
    type === "error"
      ? "bg-red-soft text-red"
      : "bg-green-soft text-green";
  return (
    <p class={`px-4 py-3 rounded-xl text-sm leading-relaxed mb-1 ${styles}`}>
      {message}
    </p>
  );
}
