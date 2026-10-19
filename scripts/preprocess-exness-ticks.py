#!/usr/bin/env python3
"""Build a compact, gap-preserving M15 dataset from Exness tick-history ZIPs.

The raw archives are never committed. The output contains midpoint OHLC and
spread summary per UTC bucket, while missing market/source periods remain
missing instead of being forward-filled.
"""
from __future__ import annotations
import argparse, csv, datetime as dt, gzip, io, json, math, pathlib, zipfile

BUCKET_MS = 15 * 60 * 1000

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--output', required=True)
    p.add_argument('--metadata', required=True)
    p.add_argument('archives', nargs='+')
    return p.parse_args()

def main():
    args = parse_args()
    buckets: dict[int, dict[str, float]] = {}
    invalid = out_of_order = 0
    source_files = []
    for archive_name in args.archives:
        path = pathlib.Path(archive_name)
        source_files.append(path.name)
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.lower().endswith('.csv')]
            if len(names) != 1:
                raise ValueError(f'{path}: expected one CSV, got {names}')
            with archive.open(names[0]) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8', newline=''))
                previous_ms = None
                for row in reader:
                    try:
                        stamp = row['Timestamp'].strip().replace('Z', '+00:00')
                        timestamp = dt.datetime.fromisoformat(stamp)
                        if timestamp.tzinfo is None:
                            timestamp = timestamp.replace(tzinfo=dt.timezone.utc)
                        ms = int(timestamp.timestamp() * 1000)
                        bid = float(row['Bid']); ask = float(row['Ask'])
                        if not (math.isfinite(ms) and math.isfinite(bid) and math.isfinite(ask) and bid > 0 and ask >= bid):
                            raise ValueError
                    except (KeyError, ValueError, OverflowError):
                        invalid += 1
                        continue
                    if previous_ms is not None and ms < previous_ms:
                        out_of_order += 1
                    previous_ms = ms
                    midpoint = (bid + ask) / 2
                    spread = ask - bid
                    bucket = (ms // BUCKET_MS) * BUCKET_MS
                    item = buckets.get(bucket)
                    if item is None:
                        buckets[bucket] = {
                            'open': midpoint, 'high': midpoint, 'low': midpoint,
                            'close': midpoint, 'ticks': 1, 'spread_sum': spread,
                            'spread_min': spread, 'spread_max': spread,
                        }
                    else:
                        item['high'] = max(item['high'], midpoint)
                        item['low'] = min(item['low'], midpoint)
                        item['close'] = midpoint
                        item['ticks'] += 1
                        item['spread_sum'] += spread
                        item['spread_min'] = min(item['spread_min'], spread)
                        item['spread_max'] = max(item['spread_max'], spread)

    rows = []
    for timestamp in sorted(buckets):
        item = buckets[timestamp]
        rows.append([
            timestamp,
            round(item['open'], 5), round(item['high'], 5),
            round(item['low'], 5), round(item['close'], 5),
            int(item['ticks']),
            round(item['spread_sum'] / item['ticks'], 5),
            round(item['spread_min'], 5),
            round(item['spread_max'], 5),
        ])

    output = pathlib.Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, 'wt', encoding='utf-8', compresslevel=9) as handle:
        json.dump(rows, handle, separators=(',', ':'))

    timestamps = [row[0] for row in rows]
    metadata = {
        'provider': 'Exness', 'symbol': 'XAUUSDc', 'instrument': 'spot',
        'interval': '15min', 'price': 'midpoint((Bid+Ask)/2)',
        'spread': 'available in source ticks; summarized during preprocessing',
        'sourceFiles': source_files, 'bars': len(rows), 'invalidTicks': invalid,
        'outOfOrderTicks': out_of_order,
        'from': dt.datetime.fromtimestamp(timestamps[0] / 1000, dt.timezone.utc).isoformat() if timestamps else None,
        'to': dt.datetime.fromtimestamp(timestamps[-1] / 1000, dt.timezone.utc).isoformat() if timestamps else None,
        'note': 'Gaps are preserved. No tick, candle, or price is forward-filled.',
    }
    metadata_path = pathlib.Path(args.metadata); metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(metadata, indent=2))

if __name__ == '__main__':
    main()
