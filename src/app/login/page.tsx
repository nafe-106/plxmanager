import { redirect } from "next/navigation";
import { hasSession } from "@/lib/auth";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  if (await hasSession()) redirect("/");
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-950 px-4">
      <LoginForm />
    </main>
  );
}