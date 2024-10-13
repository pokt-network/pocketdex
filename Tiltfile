docker_build("postgres", "postgres")

docker_build("gql-engine",
             "gql-engine",
             #live_update=[
             #   sync("harmonic/bin", "/usr/local/bin"),
             #])

docker_build("indexer",
             "indexer",
             #live_update=[
             #   sync("harmonic/bin", "/usr/local/bin"),
             #])

k8s_yaml(helm("k8s/postgres",
            values="k8s/postgres/values.yaml"),
            port_forwards=["5432:5432"],
            new_name="Postgres",
            resource_deps=["Postgres"])

k8s_yaml(helm("k8s/indexer",
            values="k8s/indexer/values.yaml"),
            new_name="Indexer",
            resource_deps=["Postgres"])

k8s_yaml(helm("k8s/gql-engine",
            values="k8s/gql-engine/values.yaml"),
            new_name="GraphQL API",
            resource_deps=["Postgres"])

k8s_resource(workload="postgres-deployment",
            port_forwards=["5432:5432"])

k8s_resource(workload="indexer-deployment",
            resource_deps=["Postgres"])

k8s_resource(workload="gql-engine-deployment",
            port_forwards=["3000:3000"],
            resource_deps=["Postgres"])
