import Link from "next/link";
import DemoPlayer from "./DemoPlayer";

export default function Demo() {
  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#1c1c1e] px-8 py-12 text-white md:px-16 lg:px-24 lg:py-16">
      <Link
        href="/"
        className="mb-10 block w-fit cursor-pointer text-3xl font-bold tracking-tight text-white md:text-4xl"
      >
        EdgeSense
      </Link>

      <section className="rounded-2xl bg-white/5 p-6 ring-1 ring-white/10 md:p-8">
        <h1 className="mb-6 font-sans text-sm font-medium uppercase tracking-[0.2em] text-white">
          EDGESENSE — VIDEO ANALYSIS DEMO
        </h1>

        <DemoPlayer />
      </section>

      <p className="mt-6 font-sans text-sm text-white/50">
        Concept visualization generated for demonstration purposes. The skeletal and object representations illustrate EdgeSense&apos;s intended privacy-first processing approach and are not live model detections.
      </p>

      <div id="launch-live-demo" className="mt-10 flex justify-center">
        <Link
          href="/live-demo"
          className="inline-block cursor-pointer rounded-xl border border-white/15 bg-[#2c2c2e] px-8 py-3.5 font-sans text-base font-bold text-white transition-colors duration-200 hover:bg-[#3a3a3c]"
        >
          Launch live demo
        </Link>
      </div>
    </main>
  );
}
