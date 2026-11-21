import Link from "next/link";

/** The two places in the Studio: cuts to review, and finished variations to compare. */
export default function TopTabs({ active }: { active: "cuts" | "finals" }) {
  return (
    <nav className="toptabs" aria-label="Sections">
      <Link href="/" className={active === "cuts" ? "on" : ""}>Cuts</Link>
      <Link href="/finals" className={active === "finals" ? "on" : ""}>Final edits</Link>
    </nav>
  );
}
