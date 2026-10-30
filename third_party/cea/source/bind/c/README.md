CEA C Binding
=============
This directory provides the C ABI shim and public headers for calling the
CEA core library from C/C++ and other languages.

Contents:
- bindc.F90: Fortran ISO_C_BINDING shim
- cea.h / cea_enum.h: public C headers

Build:
- Enable with CMake: set `CEA_ENABLE_BIND_C=ON` or use the `dev` preset.

API reference:
- See `docs/source/interfaces/c_api.rst`.
