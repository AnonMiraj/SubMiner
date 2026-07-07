/*
  SubMiner - All-in-one sentence mining overlay
  Copyright (C) 2024 sudacode

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as net from 'net';
import { execSync } from 'child_process';
import { BaseWindowTracker } from './base-tracker';
import { createLogger } from '../logger';
import type { WindowGeometry } from '../types/runtime';

const log = createLogger('tracker').child('niri');

export interface NiriWindowLayout {
	pos_in_scrolling_layout: [number, number] | null;
	tile_size: [number, number];
	window_size: [number, number];
	tile_pos_in_workspace_view: [number, number] | null;
	window_offset_in_tile: [number, number];
}

export interface NiriWindow {
	id: number;
	title: string | null;
	app_id: string | null;
	pid: number | null;
	workspace_id: number | null;
	is_focused: boolean;
	is_floating: boolean;
	is_urgent: boolean;
	layout: NiriWindowLayout;
}

export interface NiriOutput {
	name: string;
	make?: string;
	model?: string;
	physical_size?: [number, number];
	modes?: Array<{ width: number; height: number; refresh_rate: number }>;
}

export function parseNiriWindows(output: string): NiriWindow[] {
	try {
		const parsed = JSON.parse(output) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed as NiriWindow[];
	} catch {
		return [];
	}
}

export function parseNiriOutputs(output: string): Record<string, NiriOutput> {
	try {
		const parsed = JSON.parse(output) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return {};
		return parsed as Record<string, NiriOutput>;
	} catch {
		return {};
	}
}

function isMpvAppId(value: string | null): boolean {
	if (!value) return false;
	return value.trim().toLowerCase().includes('mpv');
}

export function resolveNiriWindowGeometry(
	window: NiriWindow,
	outputs: Record<string, NiriOutput>,
): WindowGeometry | null {
	const { layout } = window;
	const windowSize: [number, number] = layout.window_size;

	// For floating windows, tile_pos_in_workspace_view gives screen position.
	// For tiled windows we need workspace->output mapping; fall back to tile position if available.
	let posX = 0;
	let posY = 0;

	if (window.is_floating && layout.tile_pos_in_workspace_view) {
		// Floating: position relative to workspace origin
		posX = layout.tile_pos_in_workspace_view[0] + layout.window_offset_in_tile[0];
		posY = layout.tile_pos_in_workspace_view[1] + layout.window_offset_in_tile[1];
	} else if (layout.tile_pos_in_workspace_view) {
		// Tiled: position in scrolling layout; use workspace offset from outputs
		posX = layout.tile_pos_in_workspace_view[0];
		posY = layout.tile_pos_in_workspace_view[1];
	} else {
		// Fallback: use tile size as position (unlikely but safe)
		posX = layout.window_offset_in_tile[0];
		posY = layout.window_offset_in_tile[1];
	}

	return {
		x: Math.round(posX),
		y: Math.round(posY),
		width: Math.round(windowSize[0]),
		height: Math.round(windowSize[1]),
	};
}

export class NiriWindowTracker extends BaseWindowTracker {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private pollTimeouts: Array<ReturnType<typeof setTimeout>> = [];
	private eventSocket: net.Socket | null = null;
	private readonly targetMpvSocketPath: string | null;
	private focusedWindowId: number | null = null;

	constructor(targetMpvSocketPath?: string) {
		super();
		this.targetMpvSocketPath = targetMpvSocketPath?.trim() || null;
	}

	start(): void {
		this.pollInterval = setInterval(() => this.pollGeometry(), 250);
		this.pollGeometry();
		this.connectEventSocket();
	}

	stop(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		for (const timeout of this.pollTimeouts) {
			clearTimeout(timeout);
		}
		this.pollTimeouts = [];
		if (this.eventSocket) {
			this.eventSocket.destroy();
			this.eventSocket = null;
		}
	}

	private connectEventSocket(): void {
		const niriSocket = process.env.NIRI_SOCKET || process.env.NIRI_INSTANCE;
		if (!niriSocket) {
			log.info('NIRI_SOCKET not set, skipping event stream');
			return;
		}

		this.eventSocket = new net.Socket();

		this.eventSocket.on('connect', () => {
			log.info('Connected to niri event stream');
		});

		this.eventSocket.on('data', (_data: Buffer) => {
			// Event stream notifies of window changes — trigger a geometry poll
			this.scheduleGeometryPollBurst();
		});

		this.eventSocket.on('error', (err: Error) => {
			log.error('niri event socket error:', err.message);
		});

		this.eventSocket.on('close', () => {
			log.info('niri event socket closed');
		});

		this.eventSocket.connect(niriSocket);
	}

	private scheduleGeometryPollBurst(): void {
		for (const timeout of this.pollTimeouts) {
			clearTimeout(timeout);
		}
		this.pollTimeouts = [0, 50, 150, 300].map((delayMs) => {
			const pollTimeout = setTimeout(() => {
				this.pollTimeouts = this.pollTimeouts.filter((timeout) => timeout !== pollTimeout);
				this.pollGeometry();
			}, delayMs);
			return pollTimeout;
		});
		for (const pollTimeout of this.pollTimeouts) {
			pollTimeout.unref?.();
		}
	}

	private pollGeometry(): void {
		try {
			const output = execSync('niri msg -j windows', { encoding: 'utf-8' });
			const windows = parseNiriWindows(output);
			const mpvWindow = this.findTargetWindow(windows);

			if (mpvWindow) {
				const outputs = this.getNiriOutputs(mpvWindow);
				const geometry = resolveNiriWindowGeometry(mpvWindow, outputs);
				if (geometry) {
					this.updateGeometry(geometry);
				} else {
					this.updateGeometry(null);
				}
			} else {
				this.updateGeometry(null);
			}
		} catch {
			// niri msg not available or failed — silent fail
		}
	}

	private findTargetWindow(windows: NiriWindow[]): NiriWindow | null {
		const visibleMpvWindows = windows.filter(
			(w) =>
				isMpvAppId(w.app_id) &&
				w.pid != null,
		);

		let candidates = visibleMpvWindows;

		if (this.targetMpvSocketPath) {
			candidates = visibleMpvWindows.filter((w) => {
				if (!w.pid) return false;
				const cmdline = this.getWindowCommandLine(w.pid);
				if (!cmdline) return false;
				return (
					cmdline.includes(`--input-ipc-server=${this.targetMpvSocketPath}`) ||
					cmdline.includes(`--input-ipc-server ${this.targetMpvSocketPath}`)
				);
			});
		}

		// Prefer focused window among candidates
		if (candidates.length === 0) return null;
		const focused = candidates.find((w) => w.is_focused);
		return focused ?? candidates[0] ?? null;
	}

	private getNiriOutputs(_window: NiriWindow): Record<string, NiriOutput> {
		try {
			const output = execSync('niri msg -j outputs', { encoding: 'utf-8' });
			return parseNiriOutputs(output);
		} catch {
			return {};
		}
	}

	private getWindowCommandLine(pid: number): string | null {
		try {
			const cmdline = execSync(`ps -p ${pid} -o args=`, {
				encoding: 'utf-8',
			}).trim();
			return cmdline || null;
		} catch {
			return null;
		}
	}
}
