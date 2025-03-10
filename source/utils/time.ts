export function parseDuration(duration: string): number {
	const units: Record<string, number> = {
		millisecond: 1,
		milliseconds: 1,
		second: 1000,
		seconds: 1000,
		minute: 60 * 1000,
		minutes: 60 * 1000,
		hour: 60 * 60 * 1000,
		hours: 60 * 60 * 1000,
		day: 24 * 60 * 60 * 1000,
		days: 24 * 60 * 60 * 1000,
	};

	const regex = /^(\d+)\s+(.+)$/;
	const match = duration.match(regex);

	if (!match) {
		throw new Error(`Invalid duration format: ${duration}`);
	}

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	if (!(unit in units)) {
		throw new Error(`Unknown time unit: ${unit}`);
	}

	return value * units[unit];
}
