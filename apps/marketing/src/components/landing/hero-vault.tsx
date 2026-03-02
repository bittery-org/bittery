import {
	ArrowRight,
	Eye,
	EyeOff,
	Fingerprint,
	KeyRound,
	Lock,
	Shield,
	Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";

function FloatingIcon({
	icon: Icon,
	delay,
	x,
	y,
	size = 20,
}: {
	icon: React.ElementType;
	delay: number;
	x: string;
	y: string;
	size?: number;
}) {
	return (
		<motion.div
			className="absolute"
			style={{ left: x, top: y }}
			initial={{ opacity: 0, scale: 0 }}
			animate={{ opacity: 1, scale: 1 }}
			transition={{ duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] }}
		>
			<motion.div
				animate={{ y: [0, -8, 0] }}
				transition={{
					duration: 4 + delay,
					repeat: Number.POSITIVE_INFINITY,
					ease: "easeInOut",
				}}
			>
				<div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card shadow-black/6 shadow-lg backdrop-blur-sm sm:size-12 dark:shadow-black/20">
					<Icon
						className="text-primary/70"
						style={{ width: size, height: size }}
					/>
				</div>
			</motion.div>
		</motion.div>
	);
}

function VaultVisual() {
	return (
		<div className="relative mx-auto aspect-square w-full max-w-md">
			{/* Outer ring */}
			<motion.div
				className="absolute inset-8 rounded-full border-2 border-primary/15 border-dashed sm:inset-12"
				initial={{ opacity: 0, scale: 0.8, rotate: -30 }}
				animate={{ opacity: 1, scale: 1, rotate: 0 }}
				transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
			>
				<motion.div
					className="absolute inset-0 rounded-full"
					animate={{ rotate: 360 }}
					transition={{
						duration: 60,
						repeat: Number.POSITIVE_INFINITY,
						ease: "linear",
					}}
				>
					<div className="absolute top-0 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/30" />
					<div className="absolute bottom-0 left-1/2 size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-primary/20" />
					<div className="absolute top-1/2 left-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/25" />
					<div className="absolute top-1/2 right-0 size-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/15" />
				</motion.div>
			</motion.div>

			{/* Inner ring */}
			<motion.div
				className="absolute inset-20 rounded-full border border-primary/10 sm:inset-24"
				initial={{ opacity: 0, scale: 0.6 }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{ duration: 1, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
			/>

			{/* Center shield */}
			<motion.div
				className="absolute inset-0 flex items-center justify-center"
				initial={{ opacity: 0, scale: 0.5 }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{ duration: 0.8, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
			>
				<div className="relative">
					<div className="absolute -inset-6 rounded-full bg-primary/6 blur-2xl" />
					<motion.div
						className="relative flex size-20 items-center justify-center rounded-3xl border border-primary/20 bg-linear-to-br from-primary/20 via-primary/10 to-primary/5 shadow-2xl shadow-primary/10 sm:size-24"
						animate={{ rotate: [0, 2, -2, 0] }}
						transition={{
							duration: 6,
							repeat: Number.POSITIVE_INFINITY,
							ease: "easeInOut",
						}}
					>
						<Shield className="size-10 text-primary sm:size-12" />
					</motion.div>
				</div>
			</motion.div>

			{/* Floating icons — positioned along the outer ring */}
			<FloatingIcon icon={Lock} delay={0.6} x="15%" y="22%" size={18} />
			<FloatingIcon icon={KeyRound} delay={0.8} x="70%" y="12%" size={18} />
			<FloatingIcon icon={Fingerprint} delay={1.0} x="75%" y="62%" size={18} />
			<FloatingIcon icon={Eye} delay={1.2} x="10%" y="62%" size={18} />
			<FloatingIcon icon={EyeOff} delay={1.4} x="42%" y="76%" size={16} />
		</div>
	);
}

export function HeroVault() {
	return (
		<section className="relative px-4 pt-28 pb-16 sm:pt-36 sm:pb-24">
			{/* Background atmosphere */}
			<div className="absolute inset-0 -z-10">
				<div className="absolute top-20 left-1/2 h-175 w-225 -translate-x-1/2 rounded-full bg-primary/3 blur-3xl" />
				<div className="absolute top-40 right-1/4 h-75 w-75 rounded-full bg-chart-4/4 blur-3xl" />
				<div className="absolute top-60 left-1/4 h-100 w-100 rounded-full bg-primary/2 blur-3xl" />
			</div>

			<div className="mx-auto max-w-5xl">
				<div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-8">
					{/* Left — copy */}
					<div className="text-center lg:text-left">
						<motion.div
							initial={{ opacity: 0, x: -20 }}
							animate={{ opacity: 1, x: 0 }}
							transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
						>
							<div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
								<span className="size-1.5 animate-pulse rounded-full bg-primary" />
								Now in public beta
							</div>

							<h1 className="font-display font-semibold text-4xl leading-[0.95] tracking-tight sm:text-5xl lg:text-[3.5rem] xl:text-6xl">
								Your passwords,{" "}
								<span className="bg-linear-to-r from-primary via-primary to-chart-4 bg-clip-text text-transparent">
									truly yours
								</span>
							</h1>

							<p className="mx-auto mt-6 max-w-136 text-base text-muted-foreground leading-relaxed sm:text-lg lg:mx-0">
								The password manager that can't spy on you — even if it
								wanted to. Your data is encrypted before it leaves your device,
								so only you can ever see it.
							</p>
						</motion.div>

						<motion.div
							className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:items-start lg:justify-start"
							initial={{ opacity: 0, x: -20 }}
							animate={{ opacity: 1, x: 0 }}
							transition={{ duration: 0.7, delay: 0.15 }}
						>
							<Button
								size="lg"
								className="h-11 gap-2 rounded-full px-7 text-sm"
							>
								Get Started
								<ArrowRight className="size-4" />
							</Button>
							<Button
								size="lg"
								variant="outline"
								className="h-11 gap-2 rounded-full px-7 text-sm"
							>
								<Sparkles className="size-4" />
								See Features
							</Button>
						</motion.div>

						<motion.div
							className="mt-8 flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm sm:flex-row sm:gap-6 lg:justify-start"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.6, delay: 0.4 }}
						>
							<div className="flex items-center gap-1.5">
								<div className="size-1.5 rounded-full bg-emerald-500" />
								Zero-knowledge encryption
							</div>
							<div className="flex items-center gap-1.5">
								<div className="size-1.5 rounded-full bg-emerald-500" />
								Open source
							</div>
							<div className="flex items-center gap-1.5">
								<div className="size-1.5 rounded-full bg-emerald-500" />
								Every platform
							</div>
						</motion.div>
					</div>

					{/* Right — vault visual */}
					<motion.div
						initial={{ opacity: 0, scale: 0.9 }}
						animate={{ opacity: 1, scale: 1 }}
						transition={{ duration: 0.8, delay: 0.2 }}
					>
						<VaultVisual />
					</motion.div>
				</div>
			</div>
		</section>
	);
}
