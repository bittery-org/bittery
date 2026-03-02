import { Footer } from "@/components/landing/footer";
import { Header } from "@/components/landing/header";

interface LayoutProps {
	children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
	return (
		<div className="min-h-screen">
			<Header />
			<main>{children}</main>
			<Footer />
		</div>
	);
}
