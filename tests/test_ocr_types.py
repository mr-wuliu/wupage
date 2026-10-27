"""Reject type-incompatible models before generating a reduced OCR runtime."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "build/ocr"))
import onnx
from model_types import audit_model_types

DISABLED = ["float4", "float8", "optional", "sparsetensor", "string"]


class ModelTypeTests(unittest.TestCase):
    def model(self, kind=onnx.TensorProto.FLOAT):
        value = onnx.helper.make_tensor_value_info("input", kind, [1])
        result = onnx.helper.make_tensor_value_info("output", kind, [1])
        graph = onnx.helper.make_graph([onnx.helper.make_node("Identity", ["input"], ["output"])], "types", [value], [result])
        return onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 13)])

    def test_retains_float_and_integer_models(self):
        for kind in (onnx.TensorProto.FLOAT, onnx.TensorProto.INT32, onnx.TensorProto.INT64):
            with self.subTest(kind=kind):
                report = audit_model_types(self.model(kind), DISABLED)
                self.assertEqual(report["element_types"], [onnx.TensorProto.DataType.Name(kind)])

    def test_rejects_disabled_tensor_types(self):
        for kind, flag in [(onnx.TensorProto.STRING, "string"), (onnx.TensorProto.FLOAT8E4M3FN, "float8"),
                           (onnx.TensorProto.FLOAT4E2M1, "float4")]:
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, flag):
                audit_model_types(self.model(kind), DISABLED)

    def test_rejects_cast_to_disabled_type_even_without_output_type_information(self):
        model = self.model()
        model.graph.node[0].CopyFrom(onnx.helper.make_node("Cast", ["input"], ["output"], to=onnx.TensorProto.STRING))
        with self.assertRaisesRegex(ValueError, "string"):
            audit_model_types(model, DISABLED)

    def test_rejects_string_constant_attributes(self):
        model = self.model()
        model.graph.node[0].CopyFrom(onnx.helper.make_node("Constant", [], ["output"], value_string="text"))
        with self.assertRaisesRegex(ValueError, "string"):
            audit_model_types(model, DISABLED)

    def test_rejects_unresolved_intermediate_types(self):
        model = self.model()
        model.graph.output[0].ClearField("type")
        model.graph.node[0].CopyFrom(onnx.helper.make_node("Unknown", ["input"], ["output"], domain="custom"))
        model.opset_import.append(onnx.helper.make_opsetid("custom", 1))
        with self.assertRaisesRegex(ValueError, "Cannot prove model output types"):
            audit_model_types(model, DISABLED)

    def test_rejects_optional_container(self):
        model = self.model()
        model.graph.input[0].type.Clear()
        model.graph.input[0].type.optional_type.elem_type.tensor_type.elem_type = onnx.TensorProto.FLOAT
        with self.assertRaisesRegex(ValueError, "optional"):
            audit_model_types(model, DISABLED)

    def test_rejects_sparse_initializer(self):
        model = self.model()
        sparse = model.graph.sparse_initializer.add()
        sparse.values.data_type = onnx.TensorProto.FLOAT
        sparse.indices.data_type = onnx.TensorProto.INT64
        with self.assertRaisesRegex(ValueError, "sparsetensor"):
            audit_model_types(model, DISABLED)

    def test_checks_nested_graphs(self):
        model = self.model()
        nested = self.model(onnx.TensorProto.STRING).graph
        node = onnx.helper.make_node("If", [], ["branch"], then_branch=nested, else_branch=nested)
        model.graph.node.append(node)
        with self.assertRaisesRegex(ValueError, "string"):
            audit_model_types(model, DISABLED)

    def test_ordinary_string_attributes_do_not_require_string_tensors(self):
        model = self.model()
        model.graph.node[0].CopyFrom(onnx.helper.make_node("Resize", ["input", "", "scales"], ["output"], mode="nearest"))
        model.graph.initializer.append(onnx.helper.make_tensor("scales", onnx.TensorProto.FLOAT, [1], [1.0]))
        model.graph.doc_string = "中文、日本語 and English OCR remain text outside the model"
        report = audit_model_types(model, DISABLED)
        self.assertEqual(report["element_types"], ["FLOAT"])


if __name__ == "__main__":
    unittest.main()
