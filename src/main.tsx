import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Worker queries use local databases. Catalog reads fall back to cache,
      // so the browser's connection status must never pause local work.
      networkMode: "always",
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: Infinity, // Database doesn't change
    },
    mutations: {
      networkMode: "always",
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
