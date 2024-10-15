docker_build("postgres-custom", ".", dockerfile="docker/pg-Dockerfile")

docker_build("indexer", ".",
             dockerfile="docker/dev-node.dockerfile",
             build_args={"GENESIS_FILENAME": "localnet.json"},
             #live_update=[
             #   sync("harmonic/bin", "/usr/local/bin"),
             #])
             )

k8s_yaml(helm("k8s/postgres", values="k8s/postgres/values.yaml"))

k8s_yaml(helm("k8s/indexer", values="k8s/indexer/dev-indexer-values.yaml"))

k8s_yaml(helm("k8s/gql-engine", values="k8s/gql-engine/dev-gql-engine-values.yaml"))

k8s_resource(workload="postgres-deployment",
             new_name="Postgres",
             port_forwards=["5432:5432"])

k8s_resource(workload="indexer-deployment",
             new_name="Indexer",
             resource_deps=["Postgres"])

k8s_resource(workload="gql-engine-deployment",
             new_name="GraphQL API",
             port_forwards=["3000:3000"],
             resource_deps=["Postgres", "Indexer"])
