import { createClient } from "@/lib/supabase/server";

const cards = [
  ["Listings", "listings"],
  ["Orders", "orders"],
  ["Shipments", "shipments"],
  ["Returns", "returns"],
  ["Notifications", "notifications"],
] as const;

async function countRows(supabase: Awaited<ReturnType<typeof createClient>>, table: (typeof cards)[number][1]) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  return { count: count ?? 0, error };
}

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main style={{ maxWidth: 960, margin: "0 auto", padding: 40, fontFamily: "system-ui, sans-serif" }}>
        <h1>Flipkart Seller Manager</h1>
        <p>Sign in to view seller operations data.</p>
      </main>
    );
  }

  const results = await Promise.all(cards.map(([_, table]) => countRows(supabase, table)));
  const failed = results.some((result) => result.error);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <header style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: "#666" }}>SELLER OPERATIONS</div>
        <h1 style={{ margin: "6px 0" }}>Flipkart Seller Manager</h1>
        <p style={{ margin: 0, color: "#666" }}>
          Read-only operational snapshot from Supabase.
        </p>
      </header>

      <section style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14,
        marginBottom: 24,
      }}>
        {cards.map(([label], index) => (
          <article key={label} style={{
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 18,
            background: "#fff",
          }}>
            <div style={{ color: "#666", fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 32, fontWeight: 700, marginTop: 8 }}>{results[index].count}</div>
          </article>
        ))}
      </section>

      <section style={{
        border: "1px solid #ddd",
        borderRadius: 12,
        padding: 18,
        background: "#fff",
      }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>System status</h2>
        <p style={{ marginBottom: 0, color: failed ? "crimson" : "green" }}>
          Database reads: {failed ? "one or more failed" : "healthy"}
        </p>
        <p style={{ color: "#666", fontSize: 13, marginBottom: 0 }}>
          Signed in as {user.email ?? user.id}
        </p>
      </section>
    </main>
  );
}
