import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { error } = await supabase.from("locations").select("id").limit(1);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>Flipkart Seller Manager</h1>
      <p>Application foundation is connected to Supabase.</p>
      <p style={{ color: error ? "crimson" : "green" }}>
        Database connection: {error ? "failed" : "ready"}
      </p>
    </main>
  );
}