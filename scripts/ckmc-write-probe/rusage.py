"""Print ri_diskio_byteswritten / bytesread for each pid (macOS proc_pid_rusage, RUSAGE_INFO_V2)."""
import ctypes, sys, json
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
class RUsageV2(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f"f{i}", ctypes.c_uint64) for i in range(16)] + [
        ("bytesread", ctypes.c_uint64), ("byteswritten", ctypes.c_uint64)]
out = {}
for pid in sys.argv[1:]:
    ru = RUsageV2()
    rc = libc.proc_pid_rusage(int(pid), 2, ctypes.byref(ru))
    out[pid] = {"rc": rc, "written": ru.byteswritten, "read": ru.bytesread}
print(json.dumps(out))
