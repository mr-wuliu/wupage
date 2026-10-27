"""Inventory ONNX model types before disabling optional runtime type support."""
from __future__ import annotations

import onnx


def audit_model_types(model, disabled: list[str]) -> dict:
    elements: set[str] = set()
    containers: set[str] = set()

    def element(value):
        if value:
            elements.add(onnx.TensorProto.DataType.Name(value))

    def visit(message):
        name = message.DESCRIPTOR.name
        if name == "TensorProto":
            element(message.data_type)
        elif name == "TypeProto":
            kind = message.WhichOneof("value")
            if kind:
                containers.add(kind)
                value = getattr(message, kind)
                if kind in ("tensor_type", "sparse_tensor_type"):
                    element(value.elem_type)
                elif kind == "map_type":
                    element(value.key_type)
        elif name == "SparseTensorProto":
            containers.add("sparse_tensor_type")
        elif name == "NodeProto":
            # A Cast target can introduce a type absent from input declarations
            # and initializers. Do not confuse normal string attributes with
            # STRING tensors: names, resize modes and OCR text remain supported.
            for attribute in message.attribute:
                if message.op_type == "Constant" and attribute.name in ("value_string", "value_strings"):
                    element(onnx.TensorProto.STRING)
                if attribute.name in ("to", "dtype", "output_dtype") and attribute.type == onnx.AttributeProto.INT:
                    element(attribute.i)
        for field, value in message.ListFields():
            if field.type == field.TYPE_MESSAGE:
                for child in value if field.is_repeated else [value]:
                    visit(child)

    def check():
        required = set()
        if "STRING" in elements:
            required.add("string")
        if any(name.startswith("FLOAT4") for name in elements):
            required.add("float4")
        if any(name.startswith("FLOAT8") for name in elements):
            required.add("float8")
        if "optional_type" in containers:
            required.add("optional")
        if "sparse_tensor_type" in containers:
            required.add("sparsetensor")
        conflicts = required.intersection(disabled)
        if conflicts:
            raise ValueError("Model requires disabled ONNX Runtime types: " + ", ".join(sorted(conflicts)))

    visit(model)
    check()
    # The recognition model uses an old Constant opset with INT64 constants
    # accepted by ORT but rejected by ONNX's strict schema checker. Keep the
    # pinned model unchanged and supplement its serialized type inventory with
    # best-effort intermediate type inference; real inference remains mandatory.
    inferred = onnx.shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    visit(inferred)
    check()

    def concrete(type_proto):
        kind = type_proto.WhichOneof("value")
        if kind in ("tensor_type", "sparse_tensor_type"):
            return bool(getattr(type_proto, kind).elem_type)
        if kind in ("sequence_type", "optional_type"):
            return concrete(getattr(type_proto, kind).elem_type)
        if kind == "map_type":
            return bool(type_proto.map_type.key_type) and concrete(type_proto.map_type.value_type)
        return False

    def coverage(graph):
        typed = {value.name for value in [*graph.input, *graph.output, *graph.value_info] if concrete(value.type)}
        outputs = {name for node in graph.node for name in node.output if name}
        missing = outputs - typed
        if missing:
            raise ValueError("Cannot prove model output types: " + ", ".join(sorted(missing)))
        count = len(outputs)
        for node in graph.node:
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.GRAPH:
                    count += coverage(attribute.g)
                elif attribute.type == onnx.AttributeProto.GRAPHS:
                    count += sum(coverage(nested) for nested in attribute.graphs)
        return count

    return {"element_types": sorted(elements), "container_types": sorted(containers),
            "checked_node_outputs": coverage(inferred.graph)}
