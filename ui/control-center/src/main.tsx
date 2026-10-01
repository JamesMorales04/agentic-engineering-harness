import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider, useNavigate } from "@tanstack/react-router";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchInterval: 15_000, retry: 1 } } });

const rootRoute = createRootRoute();
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({ mode: search.mode === "project" ? "project" as const : "home" as const }),
  component: RoutedApp
});
const routeTree = rootRoute.addChildren([homeRoute]);
const router = createRouter({ routeTree });

function RoutedApp() {
  const { mode } = homeRoute.useSearch();
  const navigate = useNavigate({ from: homeRoute.fullPath });
  return <App mode={mode} onModeChange={(next) => void navigate({ search: () => ({ mode: next }) })} />;
}

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
