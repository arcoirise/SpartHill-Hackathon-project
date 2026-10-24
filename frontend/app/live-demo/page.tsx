import Link from "next/link";

export default function LiveDemo() {
  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#1c1c1e] px-8 py-12 text-white md:px-16 lg:px-24 lg:py-16">
      <Link
        href="/"
        className="block w-fit cursor-pointer text-3xl font-bold tracking-tight text-white md:text-4xl"
      >
        EdgeSense
      </Link>
    </main>
  );
}
