load("./tiltfiles/pocketdex.tilt", "pocketdex")
pocketdex("./",
          # TODO(@bryanchriswhite): load genesis file name from env var or config file.
          genesis_file_name="testnet.json",
          postgres_values_path="./tiltfiles/k8s/postgres/postgres-values.yaml",
          pgadmin_values_path="./tiltfiles/k8s/pgadmin/pgadmin-values.yaml",
          indexer_values_path="./tiltfiles/k8s/indexer/dev-testnet-indexer-values.yaml",
          gql_engine_values_path="./tiltfiles/k8s/gql-engine/dev-gql-engine-values.yaml")
