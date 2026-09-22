import { redirect } from "next/navigation";
import { hasSession } from "@/lib/auth";
import Nav from "@/components/Nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await hasSession())) redirect("/login");
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}