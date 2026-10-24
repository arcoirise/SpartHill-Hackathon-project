import Link from "next/link";
import ComparisonSlider from "./ComparisonSlider";

const VALUES = [
  {
    title: "Safety without surveillance.",
    description:
      "Identify workplace hazards without recording or identifying workers.",
  },
  {
    title: "Privacy built into every frame.",
    description:
      "Process camera footage locally and discard raw frames after analysis.",
  },
  {
    title: "Prevent injuries before they happen.",
    description:
      "Detect risky lifting posture and deliver immediate ergonomic feedback.",
  },
  {
    title: "Insights without identities.",
    description:
      "Turn movement data into meaningful safety recommendations without individual worker profiles.",
  },
];

export default function OurMission() {
  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#1c1c1e] px-8 py-12 text-white md:px-16 lg:px-24 lg:py-16">
      <Link
        href="/"
        className="mb-10 block w-fit cursor-pointer text-3xl font-bold tracking-tight text-white md:text-4xl"
      >
        EdgeSense
      </Link>

      <div className="grid min-h-[calc(100vh-13rem)] grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-20">
        <div className="flex flex-col">
          <p className="mb-6 text-sm font-medium uppercase tracking-[0.2em] text-white/60">
            Our mission
          </p>
          <h1 className="mb-8 font-serif text-4xl font-normal leading-[1.1] tracking-tight text-white md:text-5xl xl:text-6xl">
            {"A safer workplace shouldn't come at the cost of privacy."}
          </h1>
          <p className="max-w-xl font-sans text-base leading-relaxed text-white/70 md:text-lg">
            Every essential worker deserves protection from preventable injuries
            without sacrificing their privacy. EdgeSense uses on-device AI to
            recognize unsafe movements and provide real-time ergonomic guidance,
            without storing raw video or relying on traditional surveillance.
          </p>

          <div className="my-10 h-px w-full bg-white/15" />

          <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            {VALUES.map((v) => (
              <div key={v.title}>
                <h2 className="mb-2 font-sans text-base font-semibold text-white">
                  {v.title}
                </h2>
                <p className="font-sans text-sm leading-relaxed text-white/60">
                  {v.description}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-h-[320px] overflow-hidden rounded-2xl bg-white/5 ring-1 ring-white/10">
          <ComparisonSlider />
        </div>
      </div>

      <section className="mx-auto mt-24 max-w-3xl pb-8 lg:mt-32">
        <p className="mb-6 text-sm font-medium uppercase tracking-[0.2em] text-white/60">
          OUR PURPOSE
        </p>
        <h2 className="mb-10 font-serif text-4xl font-normal leading-[1.1] tracking-tight text-white md:text-5xl">
          Building safer workplaces through responsible AI.
        </h2>
        <div className="space-y-8 font-sans text-base leading-relaxed text-white/70 md:text-lg md:leading-loose">
          <p>
            At EdgeSense, we believe that responsible artificial intelligence should empower people, not monitor them. Across warehouses, manufacturing facilities, and other physically demanding workplaces, essential workers face preventable ergonomic injuries and hazardous conditions every day. Yet traditional AI-powered surveillance systems often force organizations to choose between improving workplace safety and respecting employee privacy. Our mission is to eliminate that trade-off by advancing ethical, transparent, and human-centered AI solutions that prioritize worker well-being, individual autonomy, and organizational accountability. By placing privacy and trust at the foundation of our technology, we aim to demonstrate that responsible AI is not simply an ethical obligation, but a practical approach to solving meaningful challenges in business and society.
          </p>
          <p>
            We envision a future where workplace safety is proactive, equitable, and accessible without relying on invasive surveillance. Through privacy-by-design principles and edge-based artificial intelligence, EdgeSense processes visual information locally, transforming live camera feeds into anonymous skeletal movement data while discarding raw video frames rather than storing them. Our approach is designed to minimize unnecessary data collection, reduce opportunities for identity-based monitoring, and provide real-time ergonomic guidance alongside actionable, privacy-conscious safety insights. By emphasizing transparency, fairness, data minimization, and human oversight, we strive to build AI systems that organizations can deploy responsibly and workers can trust. Ultimately, EdgeSense represents our commitment to using technological innovation to create measurable societal impact: preventing workplace injuries, strengthening ethical AI governance, and proving that progress in artificial intelligence should never come at the expense of human dignity.
          </p>
        </div>
      </section>

      <section className="mt-24 grid grid-cols-1 gap-12 lg:mt-32 lg:grid-cols-2 lg:gap-20">
        <div>
          <h2 className="mb-8 font-serif text-4xl font-normal leading-[1.1] tracking-tight text-white md:text-5xl">
            Understanding movement, detecting potential strain.
          </h2>
          <div className="max-w-xl space-y-6 font-sans text-base leading-relaxed text-white/70 md:text-lg">
            <p>
              EdgeSense transforms workplace activity into a privacy-conscious visualization using white skeletal outlines to represent estimated worker posture and translucent gray hitboxes to identify surrounding objects, including boxes, shelving inventory, and the pallet jack.
            </p>
            <p>
              The skeletal outlines help illustrate body positioning and movement, while object hitboxes provide spatial context. By recognizing equipment such as the pallet jack, EdgeSense can better interpret how workers interact with their environment and identify movements that may contribute to ergonomic strain.
            </p>
            <p>
              Together, these visual signals demonstrate how AI could recognize unsafe pulling, bending, or reaching without identifying individual workers. Our goal is to provide actionable safety insights while minimizing personal data collection and protecting worker privacy.
            </p>
          </div>
        </div>

        <div className="relative aspect-[2048/1146] w-full self-start overflow-hidden rounded-2xl bg-white/5 ring-1 ring-white/10">
          <ComparisonSlider
            rawSrc="/raw-worker2.png"
            rawAlt="Raw warehouse camera image of workers and a pallet jack"
            skeletalSrc="/skeletal-worker2.png"
            skeletalAlt="AI visualization showing skeletal outlines and object hitboxes, including the pallet jack"
            label="Compare raw warehouse image and AI visualization"
          />
        </div>
      </section>
    </main>
  );
}
