from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from artifacts import ModelArtifact

PREFERENCE_FEATURE_DIM = 4
KNOWLEDGE_FEATURE_DIM = 6
EVENT_FEATURE_DIM = 4
HIDDEN_DIM = 8


def _pad(values: list[float], size: int = PREFERENCE_FEATURE_DIM) -> np.ndarray:
    array = np.asarray(values[:size], dtype=np.float64)
    if array.size < size:
        array = np.pad(array, (0, size - array.size))
    return array


def _sigmoid(value):
    return 1.0 / (1.0 + np.exp(-np.clip(value, -30, 30)))


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.max(values)
    exponents = np.exp(shifted)
    return exponents / max(float(np.sum(exponents)), 1e-9)


class TrainableNetwork:
    def parameters(self):
        return {key: value for key, value in vars(self).items() if isinstance(value, np.ndarray)}

    def restore(self, weights):
        if not weights:
            return
        parameters = self.parameters()
        if set(weights) != set(parameters):
            raise ValueError("Model parameter names do not match architecture")
        for key, value in weights.items():
            array = np.asarray(value, dtype=np.float64)
            if array.shape != parameters[key].shape or not np.isfinite(array).all():
                raise ValueError("Invalid model weights")
            setattr(self, key, array.copy())

    def export(self):
        return {key: value.tolist() for key, value in self.parameters().items()}


PREFERENCE_NODE_TYPES = ("student", "topic", "article", "video")
PREFERENCE_RELATIONSHIPS = (
    "STUDENT_PREFERS", "STUDENT_ENGAGED", "CONTENT_COVERS",
    "TOPIC_CO_OCCURS", "GENRE_CONTAINS", "TOPIC_MENTIONS",
)
# Only co-occurrence is symmetric. Everything else carries meaning in one
# direction: an article covering a topic says something about the topic, not
# the reverse.
PREFERENCE_SYMMETRIC = frozenset({"TOPIC_CO_OCCURS"})
PREFERENCE_HIDDEN_DIM = 6
_TYPE_INDEX = {name: index for index, name in enumerate(PREFERENCE_NODE_TYPES)}
_RELATION_INDEX = {name: index for index, name in enumerate(PREFERENCE_RELATIONSHIPS)}


class PreferenceSignedGNN(TrainableNetwork):
    """Heterogeneous, signed graph network over the Discover preference graph.

    Signed message passing follows SGCN (Derr/Ma/Tang 2018), from structural
    balance theory. Each node carries two channels:

        Balanced   B — reached along an even number of negative edges
        Unbalanced U — reached along an odd number

    so friend-of-friend and enemy-of-enemy feed B, while friend-of-enemy feeds U.
    That is what makes this genuinely signed: the sign of an edge selects *which
    parameter matrix and which channel* a message lands in, so it changes
    aggregation rather than only rescaling a final pooled vector. The predecessor
    applied sign once at pooling, which a third party's embedding never saw.

    Heterogeneity is a per-type input projection plus one scalar per relation
    (a K=1 basis decomposition, in R-GCN terms). Deliberately small: at ~280
    parameters SPSA can still move it, whereas a fully expressive variant would
    be ~1,500 and would simply never clear the promotion gate — and that failure
    is silent, presenting as "the model never promotes" rather than as an error.
    """

    def __init__(self, artifact: ModelArtifact):
        self.artifact = artifact
        rng = np.random.default_rng(artifact.seed)
        types, relations, hidden = len(PREFERENCE_NODE_TYPES), len(PREFERENCE_RELATIONSHIPS), PREFERENCE_HIDDEN_DIM
        # Per-type input projection: what lets a Topic and an Article with
        # identical raw features land in different places, replacing v1's
        # features[3] type-code hack.
        self.projection = rng.normal(0, 0.25, (types, PREFERENCE_FEATURE_DIM, hidden))
        # Signed propagation. Input is [neighbour_mean ; self], hence 2 * hidden.
        self.w_balanced = rng.normal(0, 0.25, (2 * hidden, hidden))
        self.w_unbalanced = rng.normal(0, 0.25, (2 * hidden, hidden))
        # One scalar per relation, stored as a single ndarray so that
        # TrainableNetwork.parameters() discovers it and SPSA can perturb it.
        # A dict of arrays would break both restore() and the SPSA direction.
        self.relation_coefficient = rng.normal(1.0, 0.1, (relations,))
        # Signed link prediction over [z_student ; z_topic]; z is [B ; U].
        self.w_out = rng.normal(0, 0.2, (4 * hidden,))
        self.bias = np.zeros(1)
        # Blend against the deterministic baseline the decision layer expects.
        self.blend = np.array([0.65, 0.35])
        if artifact.lane == "preference":
            self.restore(artifact.weights)

    def _project(self, nodes) -> dict[str, np.ndarray]:
        return {
            node.node_id: _pad(node.features) @ self.projection[_TYPE_INDEX[node.node_type]]
            for node in nodes
        }

    @staticmethod
    def _buckets(edges):
        """(target, sign) -> [(source, relation_index, weight)], direction respected."""
        buckets: dict[tuple[str, int], list[tuple[str, int, float]]] = defaultdict(list)
        for edge in edges:
            index = _RELATION_INDEX[edge.relationship]
            buckets[(edge.to_id, edge.sign)].append((edge.from_id, index, edge.weight))
            if edge.relationship in PREFERENCE_SYMMETRIC:
                buckets[(edge.from_id, edge.sign)].append((edge.to_id, index, edge.weight))
        return buckets

    def _aggregate(self, node_id, sign, buckets, source, hidden_dim):
        """Relation-weighted mean of one node's same-sign neighbours."""
        contributions, total = np.zeros(hidden_dim), 0.0
        for neighbour, relation_index, weight in buckets.get((node_id, sign), ()):
            vector = source.get(neighbour)
            if vector is None:
                continue
            scale = float(self.relation_coefficient[relation_index]) * weight
            contributions += scale * vector
            total += abs(scale)
        return contributions / total if total > 1e-9 else contributions

    def embed(self, nodes, edges) -> dict[str, np.ndarray]:
        hidden = self._project(nodes)
        buckets = self._buckets(edges)
        dim = PREFERENCE_HIDDEN_DIM
        embeddings = {}
        for node in nodes:
            own = hidden[node.node_id]
            positive = self._aggregate(node.node_id, 1, buckets, hidden, dim)
            negative = self._aggregate(node.node_id, -1, buckets, hidden, dim)
            # Balanced takes the friendly neighbourhood, unbalanced the hostile
            # one. Swapping which matrix sees which is the whole mechanism.
            balanced = np.maximum(0, np.concatenate([positive, own]) @ self.w_balanced)
            unbalanced = np.maximum(0, np.concatenate([negative, own]) @ self.w_unbalanced)
            embeddings[node.node_id] = np.concatenate([balanced, unbalanced])
        return embeddings

    def score(self, nodes, edges) -> list[dict]:
        embeddings = self.embed(nodes, edges)
        students = [n for n in nodes if n.node_type == "student"]
        topics = [n for n in nodes if n.node_type == "topic"]
        dim = 2 * PREFERENCE_HIDDEN_DIM
        # The student is a real node now, so affinity is signed link prediction
        # on a (student, topic) pair rather than a pooled vector computed outside
        # the graph. With no student node the learned term contributes nothing
        # and the baseline carries the score.
        student_vector = embeddings[students[0].node_id] if students else np.zeros(dim)
        results = []
        for topic in topics:
            pair = np.concatenate([student_vector, embeddings[topic.node_id]])
            raw = float(pair @ self.w_out + self.bias[0]) if students else 0.0
            affinity = float(np.tanh(self.blend[0] * raw + self.blend[1] * topic.baseline_score))
            results.append({"topicId": topic.node_id, "affinity": affinity})
        return results


class KnowledgeGraphTemporalNetwork(TrainableNetwork):
    """Graph-attention concept encoder plus a GRU-style temporal evidence head."""

    def __init__(self, artifact: ModelArtifact):
        self.artifact = artifact
        rng = np.random.default_rng(artifact.seed + 101)
        self.w_graph = rng.normal(0, 0.25, (KNOWLEDGE_FEATURE_DIM, HIDDEN_DIM))
        self.attention = rng.normal(0, 0.2, HIDDEN_DIM * 2)
        self.wz = rng.normal(0, 0.2, (EVENT_FEATURE_DIM + HIDDEN_DIM, HIDDEN_DIM))
        self.wr = rng.normal(0, 0.2, (EVENT_FEATURE_DIM + HIDDEN_DIM, HIDDEN_DIM))
        self.wh = rng.normal(0, 0.2, (EVENT_FEATURE_DIM + HIDDEN_DIM, HIDDEN_DIM))
        self.output = rng.normal(0, 0.2, (HIDDEN_DIM * 2, 3))
        if artifact.lane == "knowledge":
            self.restore(artifact.weights)

    def _graph_attention(self, concepts, edges) -> dict[str, np.ndarray]:
        projected = {
            item.concept_id: _pad(item.features, KNOWLEDGE_FEATURE_DIM) @ self.w_graph
            for item in concepts
        }
        neighbours: dict[str, set[str]] = defaultdict(set)
        for edge in edges:
            # Prerequisite -> dependent: aggregate into the dependent only.
            neighbours[edge.to_id].add(edge.from_id)
            if edge.relationship == "SIBLING_OF":
                neighbours[edge.from_id].add(edge.to_id)
        result = {}
        for node_id, value in projected.items():
            peers = [key for key in neighbours.get(node_id, set()) if key in projected]
            if not peers:
                result[node_id] = np.tanh(value)
                continue
            logits = []
            peer_values = []
            for peer in peers:
                peer_value = projected[peer]
                raw = float(np.dot(np.concatenate([value, peer_value]), self.attention))
                logits.append(raw if raw >= 0 else 0.2 * raw)
                peer_values.append(peer_value)
            weights = _softmax(np.asarray(logits))
            result[node_id] = np.tanh(value + sum(weight * peer for weight, peer in zip(weights, peer_values)))
        return result

    def _temporal(self, events) -> dict[str, np.ndarray]:
        states: dict[str, np.ndarray] = defaultdict(lambda: np.zeros(HIDDEN_DIM))
        last_time = {}
        for event in sorted(events, key=lambda item: item.observed_at or 0):
            current = event.observed_at or 0
            elapsed_days = max(0, current - last_time.get(event.concept_id, current)) / 86400
            last_time[event.concept_id] = current
            x = _pad(
                [event.outcome, event.weight, event.difficulty, min(1, math.log1p(elapsed_days) / 5)],
                EVENT_FEATURE_DIM,
            )
            previous = states[event.concept_id]
            combined = np.concatenate([x, previous])
            z = _sigmoid(combined @ self.wz)
            r = _sigmoid(combined @ self.wr)
            candidate = np.tanh(np.concatenate([x, r * previous]) @ self.wh)
            states[event.concept_id] = (1 - z) * previous + z * candidate
        return states

    def score(self, concepts, events, edges) -> list[dict]:
        graph = self._graph_attention(concepts, edges)
        temporal = self._temporal(events)
        results = []
        for item in concepts:
            combined = np.concatenate([graph[item.concept_id], temporal[item.concept_id]])
            raw = _sigmoid(combined @ self.output)
            # Cold-start prior remains visible instead of allowing random
            # bootstrap weights to overwrite a deterministic mastery estimate.
            mastery = float(0.7 * item.baseline_mastery + 0.3 * raw[0])
            results.append({
                "conceptId": item.concept_id,
                "mastery": mastery,
                # The current next-outcome objective supervises only mastery.
                # Do not expose unsupervised random heads as recall/readiness.
                "recallStability": float(np.clip(_pad(item.features, KNOWLEDGE_FEATURE_DIM)[1], 0, 1)),
                "difficultyReadiness": float(0.65 * mastery + 0.35 * np.clip(_pad(item.features, KNOWLEDGE_FEATURE_DIM)[2], 0, 1)),
            })
        return results
