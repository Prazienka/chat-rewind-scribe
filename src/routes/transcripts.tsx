import { createFileRoute } from "@tanstack/react-router";

import { ChatWorkspace } from "@/components/chat-workspace";

export const Route = createFileRoute("/transcripts")({
  head: () => ({
    meta: [
      { title: "Přepisy — Chat Scribe" },
      { name: "description", content: "Procházejte, hledejte, upravujte a exportujte své nahrávky, přepisy a AI shrnutí." },
      { property: "og:title", content: "Přepisy — Chat Scribe" },
      { property: "og:description", content: "Knihovna vašich nahrávek, přepisů a AI shrnutí na jednom místě." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TranscriptsPage,
});

function TranscriptsPage() {
  return <ChatWorkspace mode="library" />;
}