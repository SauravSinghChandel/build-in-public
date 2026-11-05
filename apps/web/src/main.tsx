import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
const root = createRootRoute({ component: App });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/" }),
  createRoute({ getParentRoute: () => root, path: "/projects/$projectId" }),
  createRoute({ getParentRoute: () => root, path: "/settings" }),
  createRoute({ getParentRoute: () => root, path: "/content" }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/stories",
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/stories/$storyId",
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/media",
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/context",
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId/settings",
  }),
];
const router = createRouter({ routeTree: root.addChildren(routes) });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
