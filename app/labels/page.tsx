import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import LabelWorkspace from "./label-workspace";

export default async function LabelsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <main className="main">
      <LabelWorkspace />
    </main>
  );
}
