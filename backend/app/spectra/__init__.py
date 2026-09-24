from .nmr import predict_nmr
from .ir import predict_ir
from .scaffolds import detect_functional_groups, detect_named_scaffolds

__all__ = ["predict_nmr", "predict_ir", "detect_functional_groups", "detect_named_scaffolds"]