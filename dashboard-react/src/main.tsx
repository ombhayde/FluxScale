import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";

import App from "./App.tsx";
import ConnectedApp from "./ConnectedApp.tsx";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1_000,
      refetchInterval: 2_000,
      refetchIntervalInBackground: true,
      retry: 3,
    },
  },
});

document.documentElement.classList.remove("dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">{window.location.pathname === '/connected' ? <ConnectedApp /> : <App />}</MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
