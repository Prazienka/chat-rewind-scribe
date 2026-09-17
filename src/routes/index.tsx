import { createFileRoute } from "@tanstack/react-router";

import { ChatWorkspace } from "@/components/chat-workspace";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Nová nahrávka — Chat Scribe" },
      { name: "description", content: "Nahrajte rozhovor nebo importujte zvuk a nechte Chat Scribe připravit přepis i AI shrnutí." },
      { property: "og:title", content: "Nová nahrávka — Chat Scribe" },
      { property: "og:description", content: "Nahrajte rozhovor a získejte přesný přepis i stručné AI shrnutí." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RecorderPage,
});

function RecorderPage() {
  return <ChatWorkspace mode="recorder" />;
}