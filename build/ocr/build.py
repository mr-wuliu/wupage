"""Rebuild WuPage's pinned, model-specific OCR WebAssembly libraries.

Run on Linux (including WSL) with the packages in requirements.txt installed.
Build directories and downloaded models are outside the shipped extension.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CONFIG = json.loads((HERE / "runtime.json").read_text())


def run(*args: str | Path, cwd: Path | None = None, env: dict | None = None):
    command = [str(arg) for arg in args]
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def checkout(spec: dict, destination: Path):
    if not (destination / ".git").exists():
        destination.mkdir(parents=True, exist_ok=True)
        run("git", "init", destination)
        run("git", "-C", destination, "remote", "add", "origin", spec["repository"])
        run("git", "-C", destination, "fetch", "--depth=1", "origin", spec["revision"])
        run("git", "-C", destination, "checkout", "--detach", "FETCH_HEAD")
    actual = subprocess.check_output(["git", "-C", str(destination), "rev-parse", "HEAD"], text=True).strip()
    if actual != spec["revision"]:
        raise ValueError(f"Unexpected source revision in {destination}: {actual}")


def model_operators(models: Path, output: Path):
    import onnx
    from model_types import audit_model_types

    operators: dict[tuple[str, int], set[str]] = {}
    type_report = {"disabled_types": CONFIG["onnxruntime"]["disabledTypes"], "models": []}
    for model in CONFIG["models"]:
        filename = model["name"] + "_onnx_infer.tar"
        path = models / filename
        if not path.exists():
            models.mkdir(parents=True, exist_ok=True)
            url = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/" + filename
            print("Downloading " + url, flush=True)
            urllib.request.urlretrieve(url, path)
        data = path.read_bytes()
        if len(data) != model["bytes"] or hashlib.sha256(data).hexdigest() != model["sha256"]:
            raise ValueError(f"Model integrity check failed: {path}")
        with tarfile.open(path) as archive:
            # Read the expected model directly; never extract paths from an archive.
            member = archive.extractfile(model["name"] + "_onnx_infer/inference.onnx")
            if member is None:
                raise ValueError(f"Missing inference.onnx in {path}")
            graph_model = onnx.load_model_from_string(member.read())
        try:
            inventory = audit_model_types(graph_model, CONFIG["onnxruntime"]["disabledTypes"])
        except ValueError as error:
            raise ValueError(f"{model['name']}: {error}") from error
        type_report["models"].append({"name": model["name"], "sha256": model["sha256"], **inventory})
        versions = {op.domain or "ai.onnx": op.version for op in graph_model.opset_import}

        def visit(graph):
            for node in graph.node:
                domain = node.domain or "ai.onnx"
                operators.setdefault((domain, versions[domain]), set()).add(node.op_type)
                for attribute in node.attribute:
                    if attribute.type == onnx.AttributeProto.GRAPH:
                        visit(attribute.g)
                    elif attribute.type == onnx.AttributeProto.GRAPHS:
                        for nested in attribute.graphs:
                            visit(nested)

        visit(graph_model.graph)
    content = "# Generated from the SHA-256-pinned detection and recognition models.\n"
    content += "".join(f"{domain};{version};{','.join(sorted(names))}\n"
                       for (domain, version), names in sorted(operators.items()))
    output.write_text(content, encoding="utf-8")
    (output.parent / "model-types.json").write_text(json.dumps(type_report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(content, flush=True)


def build_opencv(source: Path, build: Path, emsdk: Path, output: Path, jobs: int):
    # OpenCV 4.10 predates Emscripten 4: remove its obsolete demangler setting
    # and filesystem/preload support, which this canvas-only pipeline never uses.
    cmake = source / "modules/js/CMakeLists.txt"
    contents = cmake.read_text()
    contents = contents.replace(" -s DEMANGLE_SUPPORT=1", "")
    contents = contents.replace("-s FORCE_FILESYSTEM=1 --use-preload-plugins ", "")
    contents = contents.replace('add_definitions("-std=c++11")', "")
    cmake.write_text(contents)
    run("python3", source / "platforms/js/build_js.py", build, "--config_only",
        "--disable_single_file", "--config", HERE / "opencv.config.py",
        "--emscripten_dir", emsdk / "upstream/emscripten",
        "--build_flags=-Oz -s ENVIRONMENT=web -s FILESYSTEM=0 ",
        "--cmake_option=-DBUILD_LIST=core,imgproc,js",
        "--cmake_option=-DBUILD_TESTS=OFF", "--cmake_option=-DBUILD_PERF_TESTS=OFF",
        "--cmake_option=-DBUILD_EXAMPLES=OFF", "--cmake_option=-DCMAKE_CXX_STANDARD=17",
        "--cmake_option=-DOPENCV_DNN_OPENCL=OFF")
    run("cmake", "--build", build, "--target", "opencv.js", "--parallel", str(jobs))
    javascript = (build / "bin/opencv.js").read_text()
    if javascript.count('"opencv_js.wasm"') != 1:
        raise ValueError("Expected one OpenCV WASM filename in the generated loader")
    wrapper = "if (typeof Module === 'undefined')\n    Module = {};\n  return cv(Module);"
    if javascript.count(wrapper) != 1:
        raise ValueError("Expected OpenCV 4.10's UMD factory wrapper")
    # Emscripten 4 makes Module local to its async factory. OpenCV 4.10's old
    # wrapper assigns an undeclared global, which fails in a strict bundle.
    javascript = javascript.replace(wrapper, "return cv({});")
    (output / "opencv.js").write_text(javascript.replace('"opencv_js.wasm"', '"opencv.wasm"').rstrip() + "\n",
                                      encoding="utf-8", newline="\n")
    shutil.copyfile(build / "bin/opencv_js.wasm", output / "opencv.wasm")
    shutil.copyfile(source / "LICENSE", output / "opencv-LICENSE.txt")
    notices = (source / "modules/js/src/helpers.js").read_text().split("\nif (typeof Module.FS")[0]
    softfloat = (source / "modules/core/src/softfloat.cpp").read_text().split('#include "precomp.hpp"')[0]
    zlib = (source / "3rdparty/zlib/LICENSE").read_text()
    (output / "opencv-NOTICES.txt").write_text(notices + "\n" + softfloat + "\nZlib\n" + zlib)


def build_ort(source: Path, build: Path, emsdk: Path, operators: Path, output: Path, jobs: int):
    sdk = source / "cmake/external/emsdk"
    if sdk.is_dir() and not any(sdk.iterdir()):
        sdk.rmdir()  # Git creates an empty directory for an uninitialized submodule.
    if not sdk.exists():
        sdk.parent.mkdir(parents=True, exist_ok=True)
        sdk.symlink_to(emsdk, target_is_directory=True)
    run("python3", source / "tools/ci_build/build.py", "--build_dir", build,
        "--config", "MinSizeRel", "--update", "--build", "--skip_tests",
        "--skip_submodule_sync", "--skip_pip_install", "--build_wasm",
        "--emsdk_version", CONFIG["emsdk"]["version"], "--enable_wasm_simd",
        "--disable_wasm_exception_catching", "--disable_rtti",
        "--disable_contrib_ops", "--disable_ml_ops", "--disable_generation_ops",
        "--disable_types", *CONFIG["onnxruntime"]["disabledTypes"],
        "--include_ops_by_config", operators, "--parallel", str(jobs),
        "--cmake_generator", "Ninja",
        "--cmake_extra_defines", "onnxruntime_BUILD_UNIT_TESTS=OFF",
        # Size comes from operator reduction and LTO. Keep O3 for convolution
        # performance: Oz noticeably slows the real detection/recognition models.
        "onnxruntime_ENABLE_LTO=ON", "CMAKE_CXX_FLAGS_MINSIZEREL=-O3 -DNDEBUG",
        "CMAKE_C_FLAGS_MINSIZEREL=-O3 -DNDEBUG")
    # Keep the npm loader's standard filenames while compiling without pthreads.
    # Both loader and binary come from the same build and use the same ABI.
    javascript = (build / "MinSizeRel/ort-wasm-simd.mjs").read_text()
    if javascript.count('"ort-wasm-simd.wasm"') != 3:
        raise ValueError("Expected three ONNX Runtime WASM filename references in the generated loader")
    (output / "ort-wasm-simd-threaded.mjs").write_text(
        javascript.replace('"ort-wasm-simd.wasm"', '"ort-wasm-simd-threaded.wasm"'), encoding="utf-8", newline="\n")
    shutil.copyfile(build / "MinSizeRel/ort-wasm-simd.wasm", output / "ort-wasm-simd-threaded.wasm")
    shutil.copyfile(source / "LICENSE", output / "onnxruntime-LICENSE.txt")
    shutil.copyfile(source / "ThirdPartyNotices.txt", output / "onnxruntime-NOTICES.txt")


def write_manifest(output: Path):
    inputs = ["build/ocr/runtime.json", "build/ocr/opencv.config.py", "build/ocr/build.py", "build/ocr/model_types.py", "build/ocr/requirements.txt"]
    files = ["opencv.js", "opencv.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
             "opencv-LICENSE.txt", "opencv-NOTICES.txt", "onnxruntime-LICENSE.txt", "onnxruntime-NOTICES.txt", "required-operators.config", "model-types.json"]
    manifest = {
        "inputs": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in inputs},
        "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name in files for data in [(output / name).read_bytes()]},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "vendor/ocr")
    parser.add_argument("--component", choices=("all", "opencv", "onnxruntime", "operators", "manifest"), default="all")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    work, output = args.work_dir.resolve(), args.output.resolve()
    work.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    if args.component == "manifest":
        write_manifest(output)
        return
    operators = work / "required-operators.config"
    if args.component in ("all", "onnxruntime", "operators"):
        model_operators((args.model_dir or work / "models").resolve(), operators)
        shutil.copyfile(operators, output / operators.name)
        shutil.copyfile(work / "model-types.json", output / "model-types.json")
    if args.component == "operators":
        return
    emsdk = work / "emsdk"
    checkout(CONFIG["emsdk"], emsdk)
    if not (emsdk / ".emscripten").exists():
        run(emsdk / "emsdk", "install", CONFIG["emsdk"]["version"])
        run(emsdk / "emsdk", "activate", CONFIG["emsdk"]["version"])
    # Use the same pinned toolchain for both builds, without changing the shell.
    os.environ["EMSDK"] = str(emsdk)
    os.environ["PATH"] = str(emsdk / "upstream/emscripten") + os.pathsep + os.environ["PATH"]
    version = subprocess.check_output([str(emsdk / "upstream/emscripten/emcc"), "--version"], text=True)
    if CONFIG["emsdk"]["version"] not in version.splitlines()[0]:
        raise ValueError("The active Emscripten compiler does not match runtime.json")
    if args.component in ("all", "opencv"):
        source = work / "opencv"
        checkout(CONFIG["opencv"], source)
        build_opencv(source, work / "opencv-build", emsdk, output, args.jobs)
    if args.component in ("all", "onnxruntime"):
        source = work / "onnxruntime"
        checkout(CONFIG["onnxruntime"], source)
        build_ort(source, work / "onnxruntime-build", emsdk, operators, output, args.jobs)
    if args.component == "all":
        write_manifest(output)


if __name__ == "__main__":
    main()
