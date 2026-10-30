#!/usr/bin/env python3
"""Extract the Bella Lui launch-site atmosphere from RocketPy's ERA5 file.

One-time extraction (plan M2.12, Q9 approved). Reads
`data/weather/bella_lui_weather_data_ERA5.nc` from a RocketPy checkout (netCDF
classic / 64-bit offset, ECMWF ERA5 pressure levels) with the Python standard
library only, and writes the committed profile
`tests/validation/bella_lui/era5_profile.csv`:

    pressure_pa, height_m (geometric, above mean sea level), temperature_k,
    wind_u_ms (toward east), wind_v_ms (toward north)

Processing follows RocketPy's `Environment.process_forecast_reanalysis`
(MIT, Copyright (c) 2018 Giovani Hidalgo Ceotto): the time step nearest the
launch date, bilinear interpolation over the grid cell holding the launch
site, geopotential / g0 -> geopotential height -> geometric height on the
WGS84 radius at the site latitude.

Contains modified Copernicus Climate Change Service information 2020
(ERA5 hourly data on pressure levels, Hersbach et al. 2018,
doi:10.24381/cds.bd0915c6). Neither the European Commission nor ECMWF is
responsible for any use that may be made of the Copernicus information or
data it contains.

Usage:
    python3 -I scripts/validation/extract_era5.py <era5.nc> <out.csv>
    python3 -I scripts/validation/extract_era5.py <era5.nc> <out.csv> --check
"""

import datetime
import math
import struct
import sys

# Launch (RocketPy tests/acceptance/test_bella_lui_rocket.py).
LAT = 47.213476
LON = 9.003336
DATE = datetime.datetime(2020, 2, 22, 13)
G0 = 9.80665
# WGS84 ellipsoid.
A_WGS84 = 6378137.0
F_WGS84 = 1 / 298.257223563

NC_DIM, NC_VAR, NC_ATT = 0x0A, 0x0B, 0x0C
NC_TYPES = {
    1: ("b", 1),
    2: ("c", 1),
    3: (">h", 2),
    4: (">i", 4),
    5: (">f", 4),
    6: (">d", 8),
}


class Reader:
    """A minimal netCDF classic (CDF-1 / CDF-2) reader."""

    def __init__(self, data):
        self.d = data
        self.p = 0
        magic = data[:3]
        if magic != b"CDF":
            raise ValueError("not a netCDF classic file")
        self.version = data[3]
        self.p = 4
        self.numrecs = self.u32()
        self.dims = self.dim_list()
        self.gatts = self.att_list()
        self.vars = self.var_list()
        self.recsize = sum(
            v["vsize"] for v in self.vars.values() if v["record"]
        )

    def u32(self):
        v = struct.unpack_from(">I", self.d, self.p)[0]
        self.p += 4
        return v

    def offset(self):
        if self.version == 2:
            v = struct.unpack_from(">Q", self.d, self.p)[0]
            self.p += 8
            return v
        return self.u32()

    def name(self):
        n = self.u32()
        s = self.d[self.p : self.p + n].decode()
        self.p += (n + 3) // 4 * 4
        return s

    def dim_list(self):
        tag, n = self.u32(), self.u32()
        out = []
        if tag == 0:
            return out
        assert tag == NC_DIM
        for _ in range(n):
            out.append((self.name(), self.u32()))
        return out

    def att_list(self):
        tag, n = self.u32(), self.u32()
        out = {}
        if tag == 0:
            return out
        assert tag == NC_ATT
        for _ in range(n):
            key = self.name()
            t, cnt = self.u32(), self.u32()
            fmt, size = NC_TYPES[t]
            raw = self.d[self.p : self.p + cnt * size]
            self.p += (cnt * size + 3) // 4 * 4
            if t == 2:
                out[key] = raw.decode(errors="replace").rstrip("\x00")
            else:
                vals = struct.unpack(">" + fmt[-1] * cnt, raw) if cnt else ()
                out[key] = vals[0] if cnt == 1 else list(vals)
        return out

    def var_list(self):
        tag, n = self.u32(), self.u32()
        out = {}
        if tag == 0:
            return out
        assert tag == NC_VAR
        for _ in range(n):
            nm = self.name()
            nd = self.u32()
            dimids = [self.u32() for _ in range(nd)]
            atts = self.att_list()
            t = self.u32()
            vsize = self.u32()
            begin = self.offset()
            shape = [self.dims[i][1] for i in dimids]
            record = bool(dimids) and self.dims[dimids[0]][1] == 0
            out[nm] = {
                "shape": shape,
                "dimids": dimids,
                "atts": atts,
                "type": t,
                "vsize": vsize,
                "begin": begin,
                "record": record,
            }
        return out

    def get(self, name, index):
        """Unpacked value of `name` at the full index tuple."""
        v = self.vars[name]
        fmt, size = NC_TYPES[v["type"]]
        shape = list(v["shape"])
        idx = list(index)
        if v["record"]:
            rec = idx[0]
            inner = shape[1:]
            flat = 0
            for i, n in zip(idx[1:], inner):
                flat = flat * n + i
            pos = v["begin"] + rec * self.recsize + flat * size
        else:
            flat = 0
            for i, n in zip(idx, shape):
                flat = flat * n + i
            pos = v["begin"] + flat * size
        raw = struct.unpack_from(fmt, self.d, pos)[0]
        a = v["atts"]
        fill = a.get("_FillValue", a.get("missing_value"))
        if fill is not None and raw == fill:
            return float("nan")
        return raw * a.get("scale_factor", 1.0) + a.get("add_offset", 0.0)

    def column(self, name):
        v = self.vars[name]
        n = self.numrecs if v["record"] else v["shape"][0]
        return [self.get(name, (i,)) for i in range(n)]


def bracket(values, x):
    """Index i with x between values[i-1] and values[i] (either order)."""
    for i in range(1, len(values)):
        lo, hi = sorted((values[i - 1], values[i]))
        if lo <= x <= hi:
            return i
    raise ValueError(f"{x} outside grid {values[0]}..{values[-1]}")


def bilinear(x, y, x1, x2, y1, y2, z11, z12, z21, z22):
    # Ported from RocketPy (MIT) rocketpy/tools.py:bilinear_interpolation
    return (
        z11 * (x2 - x) * (y2 - y)
        + z21 * (x - x1) * (y2 - y)
        + z12 * (x2 - x) * (y - y1)
        + z22 * (x - x1) * (y - y1)
    ) / ((x2 - x1) * (y2 - y1))


def earth_radius(lat_deg):
    """WGS84 geocentric radius at a geodetic latitude."""
    b = A_WGS84 * (1 - F_WGS84)
    c, s = math.cos(math.radians(lat_deg)), math.sin(math.radians(lat_deg))
    num = (A_WGS84**2 * c) ** 2 + (b**2 * s) ** 2
    den = (A_WGS84 * c) ** 2 + (b * s) ** 2
    return math.sqrt(num / den)


def hours_since(units, when):
    # "hours since 1900-01-01 00:00:00.0"
    unit, _, origin = units.partition(" since ")
    base = datetime.datetime.fromisoformat(origin.strip().split(".")[0])
    secs = (when - base).total_seconds()
    return secs / {"hours": 3600.0, "seconds": 1.0, "days": 86400.0}[unit.strip()]


def extract(path):
    with open(path, "rb") as f:
        r = Reader(f.read())
    times = r.column("time")
    t_launch = hours_since(r.vars["time"]["atts"]["units"], DATE)
    ti = min(range(len(times)), key=lambda i: abs(times[i] - t_launch))
    if times[ti] != t_launch:
        raise ValueError("launch time not in file")
    lats, lons, levels = r.column("latitude"), r.column("longitude"), r.column("level")
    yi, xi = bracket(lats, LAT), bracket(lons, LON)
    x1, x2 = lats[yi - 1], lats[yi]
    y1, y2 = lons[xi - 1], lons[xi]
    radius = earth_radius(LAT)

    def at(var, k):
        z = [[r.get(var, (ti, k, yi - 1 + a, xi - 1 + b)) for b in (0, 1)] for a in (0, 1)]
        return bilinear(LAT, LON, x1, x2, y1, y2, z[0][0], z[0][1], z[1][0], z[1][1])

    rows = []
    for k, lev in enumerate(levels):
        hgp = at("z", k) / G0
        h = radius * hgp / (radius - hgp)
        rows.append((lev * 100.0, h, at("t", k), at("u", k), at("v", k)))
    rows.sort(key=lambda row: row[1])
    return rows


HEADER = """# Bella Lui launch-site atmosphere, Kaltbrunn 2020-02-22 13:00 UTC
# (47.213476 N, 9.003336 E), extracted by scripts/validation/extract_era5.py
# from RocketPy data/weather/bella_lui_weather_data_ERA5.nc (RocketPy, MIT).
# Contains modified Copernicus Climate Change Service information 2020
# (ERA5 hourly data on pressure levels, Hersbach et al. 2018,
# doi:10.24381/cds.bd0915c6). Neither the European Commission nor ECMWF is
# responsible for any use that may be made of the Copernicus information or
# data it contains.
# height_m: geometric, above mean sea level. wind_u_ms toward east,
# wind_v_ms toward north.
pressure_pa,height_m,temperature_k,wind_u_ms,wind_v_ms
"""


def render(rows):
    body = "".join(
        f"{p:.1f},{h:.3f},{t:.4f},{u:.4f},{v:.4f}\n" for p, h, t, u, v in rows
    )
    return HEADER + body


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    text = render(extract(argv[1]))
    if "--check" in argv[3:]:
        with open(argv[2], encoding="utf-8") as f:
            ok = f.read() == text
        print("era5 profile up to date" if ok else "era5 profile differs", file=sys.stderr)
        return 0 if ok else 1
    with open(argv[2], "w", encoding="utf-8") as f:
        f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
