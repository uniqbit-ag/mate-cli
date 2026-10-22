import { navigate } from "astro:transitions/client";
import type { AstroProviderProps } from "fumadocs-core/framework/astro";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { RootProvider } from "fumadocs-ui/provider/astro";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout-options";
import SearchDialog from "./search";

/** Landing page shell: the shared header without the docs sidebar. */
export function Home({
  children,
  pathname,
  params,
}: {
  children: ReactNode;
  pathname: string;
  params: AstroProviderProps["params"];
}) {
  return (
    <RootProvider pathname={pathname} params={params} navigate={navigate} search={{ SearchDialog }}>
      <HomeLayout {...baseOptions()}>{children}</HomeLayout>
    </RootProvider>
  );
}
