import Link from "next/link";

export default function LiveDemo() {
  return (
    <main className="flex h-dvh w-full flex-col bg-[#1c1c1e] text-white">
      <Link
        href="/"
        className="block w-fit shrink-0 px-5 py-3 text-sm text-white/70 hover:text-white"
      >
        Back to EdgeSense
      </Link>
      <iframe
        src="/live-demo-app/index.html"
        title="EdgeSense live workstation assessment"
        allow="camera; fullscreen"
        className="min-h-0 w-full flex-1 border-0"
      />
    </main>
  );
}
